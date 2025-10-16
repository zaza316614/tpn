import postgres from 'pg'
import { log } from 'mentie'

// Create a connection pool to the postgres container
const { POSTGRES_PASSWORD='setthispasswordinthedotenvfile', POSTGRES_HOST='postgres', POSTGRES_PORT=5432, POSTGRES_USER='postgres', CI_MODE } = process.env
const { Pool } = postgres
log.info( `Connecting to postgres at ${ POSTGRES_USER }@${ POSTGRES_HOST }:${ POSTGRES_PORT } -p ${ POSTGRES_PASSWORD }` )
const pool = new Pool( {
    user: POSTGRES_USER,
    host: POSTGRES_HOST,
    database: 'postgres',
    password: POSTGRES_PASSWORD,
    port: POSTGRES_PORT
} )

// Helper function to close the pool
export const close_pool = async () => pool.end().then( () => log.info( 'Postgres pool closed' ) ).catch( e => log.error( 'Error closing Postgres pool:', e ) )

// Stale setting for database queries
const epoch_length_in_blocks = 300
const block_time = 12
const epoch_seconds = epoch_length_in_blocks * block_time
const epochs_until_stale = 1
const ms_to_stale = 1_000 * epoch_seconds * epochs_until_stale
const stale_timestamp = Date.now() - ms_to_stale

export async function init_tables() {


    // In dev, delete old table
    if( CI_MODE ) {
        log.info( 'Dropping old table, in CI mode' )
        await pool.query( `DROP TABLE IF EXISTS timestamps` )
        await pool.query( `DROP TABLE IF EXISTS challenges` )
        await pool.query( `DROP TABLE IF EXISTS ip_addresses` )
        await pool.query( `DROP TABLE IF EXISTS scores` )
    }


    /* //////////////////////
    // Create tables if they don't exist
    ////////////////////// */

    // Create table for timestamps
    await pool.query( `
        CREATE TABLE IF NOT EXISTS timestamps (
            label TEXT PRIMARY KEY,
            timestamp BIGINT,
            updated BIGINT
        )
    ` )

    // Create table for challenges
    await pool.query( `
        CREATE TABLE IF NOT EXISTS challenges (
            challenge TEXT PRIMARY KEY,
            response TEXT,
            miner_uid TEXT,
            created BIGINT,
            solved BIGINT
        )
    ` )

    // Create table for IP addresses
    await pool.query( `
        CREATE TABLE IF NOT EXISTS ip_addresses (
            ip_address TEXT PRIMARY KEY,
            country TEXT,
            updated BIGINT
        )
    ` )

    // Create table for scores
    await pool.query( `
        CREATE TABLE IF NOT EXISTS scores (
            challenge TEXT,
            correct BOOLEAN,
            score BIGINT,
            speed_score BIGINT,
            uniqueness_score BIGINT,
            country_uniqueness_score BIGINT,
            solved_at BIGINT
        )
    ` )

    // Create table for balances
    await pool.query( `
        CREATE TABLE IF NOT EXISTS balances (
            block BIGINT,
            miner_uid BIGINT,
            hotkey TEXT,
            balance BIGINT,
            updated BIGINT,
            PRIMARY KEY (block, miner_uid, hotkey)
        )
    ` )

    // Create a table for miner status tracking
    await pool.query( `
        CREATE TABLE IF NOT EXISTS miner_status (
            miner_uid TEXT,
            status TEXT,
            updated BIGINT,
            PRIMARY KEY (miner_uid, status, updated)
        )`
    )

    /* //////////////////////
    // Backwards iompatibility
    ////////////////////// */

    // Check if the challenges database has a miner_uid column, if not, add it
    const result = await pool.query( `
        SELECT column_name
        FROM information_schema.columns
        WHERE table_name='challenges' AND column_name='miner_uid'
    ` )
    if( result.rows.length == 0 ) {
        log.info( 'Adding miner_uid column to challenges table' )
        await pool.query( `ALTER TABLE challenges ADD COLUMN miner_uid TEXT` )
    }

    log.info( 'Tables initialized' )
}

// ///////////////////////
// Blance functions
// ///////////////////////

export async function save_balance( { block, miner_uid, hotkey, balance } ) {

    // Save the balance for the given block and miner_uid
    log.info( 'Saving balance:', { block, miner_uid, hotkey, balance } )
    
    // Save to database and make sure that if the PRIMARY KEY already exists, it will be updated
    await pool.query(
        `INSERT INTO balances (block, miner_uid, hotkey, balance, updated) VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (block, miner_uid, hotkey)
        DO UPDATE SET balance = $6, updated = $7`,
        [ block, miner_uid, hotkey, balance, Date.now(), balance, Date.now() ]
    )

    log.info( 'Balance saved:', { block, miner_uid, hotkey, balance } )
    return { block, miner_uid, hotkey, balance }

}

/**
 * Get the sma snd last known balance for a miner_uid
 * @param {string} miner_uid - The miner_uid to get the SMA for
 * @param {number} block_window - The number of blocks to calculate the SMA over
 * @returns {object} result - The last known balance and SMA for the miner_uid
 * @returns {number} result.block - The last known block for the miner_uid
 * @returns {string} result.hotkey - The last known hotkey for the miner_uid
 * @returns {number} result.balance - The last known balance for the miner_uid
 * @returns {number} result.sma - The SMA for the miner_uid
 */
export async function get_sma_for_miner_uid( { miner_uid, block_window=100 } ) {

    // First, get the last known hotkey, balance and block for this miner_uid
    const result = await pool.query(
        `SELECT hotkey, block FROM balances WHERE miner_uid = $1 ORDER BY block DESC LIMIT 1`,
        [ miner_uid ]
    )
    const { hotkey, balance, block } = result.rows[0] || {}

    // If no hotkey or block is found, return 
    if( !hotkey || !block ) {
        log.info( `No hotkey or block found for miner_uid ${ miner_uid }: `, result.rows )
        return {}
    }

    // Get all balances for this hotkey in the last block_window blocks
    const result2 = await pool.query(
        `SELECT block, balance FROM balances WHERE hotkey = $1 AND block >= $2 ORDER BY block DESC`,
        [ hotkey, block - block_window ]
    )
    const balances = result2.rows
    log.info( `Balances for hotkey ${ hotkey } in the last ${ block_window } blocks:`, balances.length )

    // If no balances are found, return null
    if( balances.length == 0 ) {
        log.info( `No balances found for hotkey ${ hotkey } in the last ${ block_window } blocks: `, result2 )
        return {}
    }

    // Calculate the SMA
    const total_balance = balances.reduce( ( acc, entry ) => acc + Number( entry.balance ), 0 )
    const sma = total_balance / balances.length
    log.info( `SMA for hotkey ${ hotkey } in the last ${ block_window } blocks:`, sma )

    // Return the balance and sma
    return {
        block,
        hotkey,
        balance,
        sma
    }

}

// /////////////////////
// Status functions
// /////////////////////

/**
 * Save the status of a miner_uid
 * @param {Object} params - The parameters for the function
 * @param {string} params.miner_uid - The miner_uid to save the status for
 * @param {'online'|'offline'|'cheat'|'misconfigured'} params.status - The status to save for the miner_uid
 * @returns {Promise<Object>} result - Returns an object with the miner_uid and status
 * @returns {string} result.miner_uid - The miner_uid that was saved
 * @returns {string} result.status - The status that was saved for the miner_uid
 */
export async function save_miner_status( { miner_uid, status } ) {

    // Save the miner status for the given miner_uid
    log.info( 'Saving miner status:', { miner_uid, status } )

    // Check if the status is valid
    const allowed_statuses = [ 'online', 'offline', 'cheat', 'misconfigured' ]
    if( !allowed_statuses.includes( status ) ) {
        log.warn( `Invalid status provided: ${ status }, allowed statuses are: ${ allowed_statuses.join( ', ' ) }` )
    }


    // Save a new status entry for this miner_uid, we are not updating entries so that we have a history of statuses
    await pool.query(
        `INSERT INTO miner_status (miner_uid, status, updated) VALUES ($1, $2, $3)
        ON CONFLICT DO NOTHING`,
        [ miner_uid, status, Date.now() ]
    )
    log.info( 'Miner status saved:', { miner_uid, status } )
    return { miner_uid, status }

}

/**
 * Get the status of a miner_uid
 * @param {Object} params - The parameters for the function
 * @param {string} params.miner_uid - The miner_uid to get the status for
 * @param {number|null} [params.from_timestamp=null] - The timestamp to get the status from (optional)
 * @param {number|null} [params.to_timestamp=null] - The timestamp to get the status to (optional)
 * @returns {Promise<Object|Array>} result - Returns the last known status if no timestamps are provided, or an array of statuses in the given range
 * @returns {string} result.status - The status of the miner_uid
 * @returns {number} result.updated - The timestamp when the status was last updated
 * @returns {Array} result - An array of status objects if timestamps are provided, or an empty array if no statuses are found
 * @returns {Object} result - An object with the last known status if no timestamps are provided, or an empty object if no statuses are found
 * @returns {number} result.updated - The timestamp when the status was last updated
 * @returns {string} result.status - The status of the miner_uid
*/
export async function get_miner_status( { miner_uid, from_timestamp=null, to_timestamp=null } ) {

    // If no timestamps are provided, get the last known status
    if( !from_timestamp && !to_timestamp ) {
        log.info( 'Getting last known status for miner_uid:', miner_uid )
        const result = await pool.query(
            `SELECT status, updated FROM miner_status WHERE miner_uid = $1 ORDER BY updated DESC LIMIT 1`,
            [ miner_uid ]
        )
        log.info( 'Query result:', result.rows )
        return result.rows.length > 0 ? result.rows[0] : {}
    }

    // If from was set, but to was not, set to now
    if( from_timestamp && !to_timestamp ) to_timestamp = Date.now()

    // If to was set, but from was not, set from to 0
    if( !from_timestamp && to_timestamp ) from_timestamp = 0

    // If timestamps are provided, get the status in that range
    log.info( 'Getting miner status for miner_uid:', miner_uid, 'from:', from_timestamp, 'to:', to_timestamp )
    const result = await pool.query(
        `SELECT status, updated FROM miner_status WHERE miner_uid = $1 AND updated >= $2 AND updated <= $3 ORDER BY updated DESC`,
        [ miner_uid, from_timestamp, to_timestamp ]
    )
    log.info( 'Query result:', result.rows )
    return result.rows.length > 0 ? result.rows : []

}

// //////////////////////
// Timestamp functions
// //////////////////////

export async function get_timestamp( { label } ) {
    // Retrieve the timestamp for the given label
    const result = await pool.query(
        `SELECT timestamp FROM timestamps WHERE label = $1 LIMIT 1`,
        [ label ]
    )
    return result.rows.length > 0 ? result.rows[0].timestamp : 0
}

export async function set_timestamp( { label, timestamp } ) {
    // Insert or update the timestamp record
    await pool.query(
        `INSERT INTO timestamps (label, timestamp, updated) VALUES ($1, $2, $3)
        ON CONFLICT (label)
        DO UPDATE SET timestamp = $4, updated = $5`,
        [ label, timestamp, Date.now(), timestamp, Date.now() ]
    )
    log.info( 'Timestamp set:', { label, timestamp } )
}

// //////////////////////
// Challenge functions
// //////////////////////

export async function save_challenge_response( { challenge, response, miner_uid='unknown' } ) {
    // Save the challenge response; errors if challenge already exists
    log.info( 'Saving challenge response:', { challenge, response, miner_uid } )
    await pool.query(
        `INSERT INTO challenges (challenge, response, miner_uid, created) VALUES ($1, $2, $3, $4)`,
        [ challenge, response, miner_uid, Date.now() ]
    )
    return { challenge, response, miner_uid }
}

export async function get_challenge_response( { challenge } ) {
    
    // Retrieve challenge response and creation time
    const query = `SELECT response, miner_uid, created FROM challenges WHERE challenge = $1 LIMIT 1`
    log.info( 'Querying for challenge response:', query, [ challenge ] )
    const result = await pool.query(
        query,
        [ challenge ]
    )
    log.info( 'Query result:', result.rows )
    return result.rows.length > 0 ? result.rows[0] : {}
}

export async function mark_challenge_solved( { challenge, read_only=false } ) {

    const now = Date.now()
    // Update the solved field if it hasn't been set yet
    if( !read_only ) await pool.query(
        `UPDATE challenges SET solved = $1 WHERE challenge = $2 AND solved IS NULL`,
        [ now, challenge ]
    )
    // Retrieve the updated solved timestamp
    const result = await pool.query(
        `SELECT solved FROM challenges WHERE challenge = $1 LIMIT 1`,
        [ challenge ]
    )
    return result.rows.length > 0 ? Number( result.rows[0].solved ) : null
}

export async function save_challenge_response_score( { correct, challenge, score, speed_score, uniqueness_score, country_uniqueness_score, solved_at }={} ) {

    // Round all numbers to nearest integer
    score = Math.round( score )
    speed_score = Math.round( speed_score )
    uniqueness_score = Math.round( uniqueness_score )
    country_uniqueness_score = Math.round( country_uniqueness_score )

    // Save score
    log.info( `Saving score for ${ challenge }:`, { correct, challenge, score, speed_score, uniqueness_score, country_uniqueness_score, solved_at } )
    await pool.query(
        `INSERT INTO scores (challenge, correct, score, speed_score, uniqueness_score, country_uniqueness_score, solved_at) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [ challenge, correct, score, speed_score, uniqueness_score, country_uniqueness_score, solved_at ]
    )
    log.info( `Score saved for ${ challenge }:`, { challenge, correct, score, speed_score, uniqueness_score, country_uniqueness_score, solved_at } )

    // TEMPORARY DEBUGGING, read the entry we just wrote
    const result = await pool.query(
        `SELECT correct, score, speed_score, uniqueness_score, country_uniqueness_score, solved_at FROM scores WHERE challenge = $1 ORDER BY solved_at ASC LIMIT 1`,
        [ challenge ]
    )
    log.info( `Reading back saved score for ${ challenge }`, result.rows )

    return { correct, score, speed_score, uniqueness_score, country_uniqueness_score, solved_at }

}

export async function get_challenge_response_score( { challenge } ) {

    // Retrieve the score for the given challenge
    log.info( `Querying for challenge response score ${ challenge }` )
    const result = await pool.query(
        `SELECT correct, score, speed_score, uniqueness_score, country_uniqueness_score, solved_at FROM scores WHERE challenge = $1 ORDER BY solved_at ASC LIMIT 1`,
        [ challenge ]
    )

    const default_values = {
        correct: false,
        score: 0,
        speed_score: 0,
        uniqueness_score: 0,
        country_uniqueness_score: 0,
        solved_at: 0,
        error: 'No score found'
    }

    const data_to_return = result.rows.length > 0 ? result.rows[0] : default_values

    log.info( `Query result for challenge response score ${ challenge }:`, result.rows, data_to_return )

    return data_to_return

}

