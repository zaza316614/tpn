import { cache, log } from "mentie"
import fetch from "node-fetch"
import { get_miner_status } from "./database.js"
import { get_tpn_cache } from "./caching.js"

/**
 * Retrieves miner statistics from the cache or computes them if not available.
 * @returns {Promise<Object>} A promise that resolves to the miner statistics object.
 */
export async function get_miner_stats() {

    // Get last known miner country stats
    const miner_country_count = get_tpn_cache( `miner_country_count`, {} )

    return miner_country_count

}

/**
 * Retrieves a list of IPs associated with a specific country.
 *
 * @param {Object} [options={}] - The options object.
 * @param {string} [options.geo] - The country code (geo) to filter IPs by.
 * @returns {Promise<string[]>} A promise that resolves to an array of IPs for the specified country.
 */
export async function get_ips_by_country( { geo }={} ) {

    // Get the minet details from cache
    const miner_country_to_ips = get_tpn_cache( `miner_country_to_ips`, {} )

    // Get the ips for this country
    let ips = miner_country_to_ips[ geo ] || []

    // If no geo was provided, return all ips
    if( !geo ) ips = Object.values( miner_country_to_ips ).flat()

    return ips

}

/**
 * Fetches failover statistics from a remote endpoint and returns the data.
 * @returns {Promise<Object>} data - An object containing the following properties:
 * @returns {Object} data.miner_ip_to_country - A mapping of miner IPs to their respective countries.
 * @returns {Object} data.miner_country_count - A mapping of countries to the number of miners in each country.
 * @returns {Object} data.miner_country_to_ips - A mapping of countries to the list of miner IPs in each country.
 * @returns {Array} data.last_known_validators - An array of the last known validators.
 */
export async function fetch_failover_stats() {

    // The Taofu validator is the failover
    const endpoint = '161.35.91.172:3000/protocol/sync/stats'

    // Warn operator that this function indicates bad configuration
    log.warn( `Your local miner data is missing, this implies your neuron is not at the latest version or it is misconfigured. Please fix it ASAP.` )

    try {

        const res = await fetch( `http://${ endpoint }` )
        const {
            miner_ip_to_country={},
            miner_country_count={},
            miner_country_to_ips={},
            last_known_validators=[]
        } = await res.json()

        return {
            miner_ip_to_country,
            miner_country_count,
            miner_country_to_ips,
            last_known_validators
        }

    } catch ( e ) {
        log.info( `Error fetching failover stats: ${ e.message }` )
        return {
            miner_ip_to_country: {},
            miner_country_count: {},
            miner_country_to_ips: {},
            last_known_validators: []
        }

    }

}

/**
 * Retrieves the last known statuses of miners.
 * @returns {Promise<Object>} result A promise that resolves to an object mapping miner UIDs to their last known statuses.
 * @returns {string} result.miner_uid - The unique identifier of the miner.
 * @returns {string} result.miner_uid.status - The status of the miner.
 * @return {number} result.miner_uid.score - The score of the miner.
 * @return {string} result.miner_uid.updated - The timestamp of the last update.
 * @return {string} result.miner_uid.updated_human - The human-readable timestamp of the last update.
 */
export async function get_miner_statuses() {

    // Handle cache
    const cache_duration_ms = 5_000 // 5 seconds
    const cached_statuses = get_tpn_cache( `last_known_miner_statuses` )
    if( cached_statuses && Date.now() - cached_statuses.timestamp < cache_duration_ms ) {
        log.info( `Returning cached miner statuses` )
        return cached_statuses.data
    }

    // Get the miner uids
    const miner_uids = get_tpn_cache( `miner_uids`, [] )

    // Get all last known statuses
    const last_known_statuses = await Promise.all( miner_uids.map( async ( miner_uid ) => {
        const status = await get_miner_status( { miner_uid } )
        return { miner_uid, ...status }
    } ) )

    // Grab the last known scores
    const stats = get_tpn_cache( 'last_known_miner_scores', {} )

    // Format to uid to status mapping
    const formatted_statuses = last_known_statuses.reduce( ( acc, _status ) => {

        const { miner_uid, status='unknown', updated=0 } = _status
        // log.info( `Last known status for miner ${ miner_uid }:`, { status, updated } )
        const { score='not in cache' } = stats[ miner_uid ] || {}
        const updated_human = new Date( Number( updated ) ).toISOString()
        acc[ miner_uid ] = { status, score, updated, updated_human }
        return acc

    }, {} )

    // Cache last known statuses
    return cache( `last_known_miner_statuses`, formatted_statuses, cache_duration_ms )

}