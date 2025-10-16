import { Router } from "express"
import { generate_challenge, solve_challenge } from "../modules/challenge.js"
import { score_request_uniqueness } from "../modules/scoring.js"
import { cache, log, make_retryable, wait } from "mentie"
import { base_url } from "../modules/url.js"
import { validate_wireguard_config } from "../modules/wireguard.js"
import { get_challenge_response, get_challenge_response_score, get_sma_for_miner_uid, save_challenge_response_score } from "../modules/database.js"
import { ip_from_req, request_is_local } from "../modules/network.js"
import { get_tpn_cache } from "../modules/caching.js"
export const router = Router()
const { CI_MODE } = process.env

// Generate challenge route
router.get( "/new", async ( req, res ) => {


    try {

        // Allow only localhost to call this route
        if( !request_is_local( req ) ) return res.status( 403 ).json( { error: `Request not from localhost` } )

        // Get miner uid from get query
        const { miner_uid } = req.query

        // If miner uid is not \d+ format, log warning
        if( miner_uid && !/^\d+$/.test( miner_uid ) ) log.warn( `Miner uid is not a number, this implies the neuron is misconfigured: `, { miner_uid } )
        if( !miner_uid ) log.warn( `No miner uid provided, this implies the neuron is misconfigured: `, { miner_uid } )

        // Generate a new challenge
        const challenge = await generate_challenge( { miner_uid } )

        // Formulate public challenge URL
        let challenge_url = new URL( base_url )
        challenge_url.pathname = `/challenge/${ challenge }`
        challenge_url.searchParams.set( 'miner_uid', miner_uid )
        challenge_url = challenge_url.toString()
        log.info( `New challenge url generated for ${ miner_uid }: ${ challenge_url }` )

        return res.json( { challenge, challenge_url } )

    } catch ( e ) {

        log.error( e )
        return res.status( 200 ).json( { error: e.message } )

    }

} )

// Scoring helper
const calculate_score = ( { uniqueness_score, ms_to_solve } ) => {

    // Score based on delay, with a grace period, and a punishment per ms above it
    const s_to_solve = ms_to_solve / 1000
    const grace_secs = 120
    const penalty = Math.min( 100, 1.1 ** ( grace_secs - s_to_solve ) )
    const speed_score = Math.sqrt( 100 - penalty )
    
    // Uniqeness score, minus maximum speed score, plus speed score
    // const score = Math.max( Math.round( uniqueness_score - 10 + speed_score ), 0 )

    // The speed score is causing discrepancies between validators, we will disable it for now
    const score = Math.round( uniqueness_score )
            
    return { score, speed_score }

}

// Challenge route, used by validator when validating challenge/responses through wireguard connection
// :challenge only - return the response for the challenge
// :challenge and :response - validate the response and return the score
// NOTE: this pathway does not solve anything. This is checked in validate_wireguard_config()
router.get( "/:challenge/:response?", async ( req, res ) => {

    const handle_route = async () => {

        // Extract challenge and response from request
        const { miner_uid } = req.query
        let { challenge, response } = req.params
        const caller = request_is_local( req ) ? 'validator' : 'miner'

        // If the response is None, that is weird python null handling and we can take it out
        if( response === 'None' ) {
            log.info( `Response was None, setting to null` )
            response = null
        }

        log.info( `[GET] ${ new Date().toString() } Challenge/response ${ challenge }${ response ? `/${ response }/` : '' }${ miner_uid ? `?miner_uid="${ miner_uid }"` : '' } called by ${ caller }` )

        /* /////////////////////////////
        //  Path 1: solving a challenge
        // ////////////////////////// */

        // If only the challenge is provided, return the response
        // this is hit when solving a GET challenge, the validator and miner both hit this
        if( !response ) {

            const cached_value = cache( `challenge_solution_${ challenge }` )
            if( cached_value ) {
                log.info( `[GET] Returning cached value to ${ caller } (no response provided) for challenge ${ challenge }: `, cached_value )
                return res.json( { response: cached_value.response } )
            }

            const challenge_response = await get_challenge_response( { challenge } )
            if( !cached_value && challenge_response.response ) cache( `challenge_solution_${ challenge }`, challenge_response )

            log.info( `[GET] Returning challenge response to ${ caller } (no response provided) for challenge ${ challenge }: `, challenge_response )
            return res.json( { ...challenge_response } )

        }

        /* /////////////////////////////
        //  Path 2: checking solution score
        // ////////////////////////// */

        let scored_response = null
        const start = Date.now()
        const timeout_ms = 60_000
        let attempt = 1

        while( !scored_response && Date.now() - start  < timeout_ms ) {

            log.info( `[WHILE] [GET] Attempt ${ attempt } at getting score for ${ challenge }` )

            // Check for cached value
            const cached_value = cache( `solution_score_${ challenge }` )
            if( cached_value ) {
                log.info( `[GET] found cashed value for ${ challenge }: `, cached_value )
                scored_response = cached_value
                continue
            }

            // Check for solved value
            log.info( `[GET] Checking for scored response in database for ${ challenge }` )
            const database_score = await get_challenge_response_score( { challenge } )
            if( database_score && !scored_response?.error ) {
                scored_response = database_score
                cache( `solution_score_${ challenge }`, scored_response )
                continue
            }

            // Wait and increment
            await wait( 5_000 )
            attempt++

        }
        
        // If there is a scored response, make very sure all properties except "correct" are typecase as numbers
        if( scored_response ) {
            const { correct, score, speed_score, uniqueness_score, country_uniqueness_score, solved_at } = scored_response
            scored_response = {
                correct,
                score: Number( score ),
                speed_score: Number( speed_score ),
                uniqueness_score: Number( uniqueness_score ),
                country_uniqueness_score: Number( country_uniqueness_score ),
                solved_at: Number( solved_at )
            }
        }

        // Get the balance data for this miner
        const balance_data = await get_sma_for_miner_uid( { miner_uid } )
        log.info( `[GET] Balance data for ${ miner_uid }: `, balance_data )

        // If there is a scored response, return it
        if( scored_response ) {
            log.info( `[GET] Returning scored value to ${ caller } for solution ${ challenge }: `, scored_response )
            return res.json( scored_response )
        }

        /* /////////////////////////////
        //  Path 3: no known score
        // ////////////////////////// */
        log.info( `[GET] [ cheater ] Returning ERROR to ${ caller } for solution ${ challenge }` )
        return res.json( { error: 'No known score for this challenge', score: 0 } )

        // // Validate the response
        // const { correct, ms_to_solve, solved_at } = await solve_challenge( { challenge, response } )

        // // If not correct, return false
        // if( !correct ) return res.json( { correct } )

        // // If correct, score the request
        // const { uniqueness_score, country_uniqueness_score } = await score_request_uniqueness( req )
        // log.info( `[GET] Uniqueness score for ${ challenge }: ${ uniqueness_score }` )
        // if( uniqueness_score === undefined && !CI_MODE ) {
        //     log.info( `Uniqueness score is undefined, returning error` )
        //     return res.status( 200 ).json( { error: 'Nice try', score: 0, correct: false } )
        // }

        // // Calculate the score
        // log.info( `[GET] Time to solve ${ challenge }: ${ ms_to_solve } (${ solved_at })` )
        // const { score, speed_score } = calculate_score( { uniqueness_score, ms_to_solve } )

        // // Formulate and cache response
        // const data = { correct, score, speed_score, uniqueness_score, country_uniqueness_score, solved_at, miner_uid }
        // await save_challenge_response_score( { correct, challenge, score, speed_score, uniqueness_score, country_uniqueness_score, solved_at } )
        // log.info( `[GET] Challenge ${ challenge } solved with score ${ score }` )
        // cache( `solution_score_${ challenge }`, data )

        // return res.json( data )

    }

    try {

        const retryable_handler = await make_retryable( handle_route, { retry_times: 2, cooldown_in_s: 10, cooldown_entropy: false, logger: log.info } )
        return retryable_handler()
        
    } catch ( e ) {

        log.error( `Error handling challenge/response routes, returning error response. Error:`, e )
        return res.status( 200 ).json( { error: e.message, score: 0 } )

    }
} )

// Wireguard challenge response route, called by the miner with a solution and wireguard config
// :challenge only - return the response for the challenge
// :challenge and :response - validate the response and return the score, expects a wireguard_config object in the request body
router.post( "/:challenge/:response", async ( req, res ) => {

    let run = 1
    const start = Date.now()

    const handle_route = async () => {

        // Extract challenge and response from request
        const { miner_uid: claimed_miner_uid } = req.query
        const { challenge, response } = req.params
        const warnings = []
        const caller = request_is_local( req ) ? 'validator' : 'miner'
        if( !challenge || !response ) return res.status( 400 ).json( { error: 'Missing challenge or response' } )

        // Log out this run
        log.info( `[POST] [run=${ run }] ${ new Date().toString() } Challenge/response ${ challenge }/${ response }?miner_uid=${ claimed_miner_uid } called by ${ caller }` )
        run++

        // Validate that claimed miner uid matches a number only format
        if( !claimed_miner_uid || !/^\d+$/.test( claimed_miner_uid ) ) {
            log.info( `[POST] [ cheater ] Bad challenge/response ${ challenge }/${ response } with body:`, req.body )
            return res.status( 400 ).json( { error: 'Bad miner uid format', score: 0, correct: false } )
        }

        // Get the expected miner uid
        const { unspoofable_ip, spoofable_ip } = ip_from_req( req )
        const miner_ip_to_uid = get_tpn_cache( `miner_ip_to_uid`, {} )
        let miner_uid = miner_ip_to_uid[ unspoofable_ip ]


        // Check that the miner version is up to date
        const miner_url = `http://${ unspoofable_ip }:3001/`
        const miner_metadata = await fetch( `${ miner_url }` ).then( res => res.json() ).catch( e => ( { error: e.message } ) )
        const minimum_version = [ 0, 0, 36 ]
        if( miner_metadata.error ) {
            log.warn( `[POST] [ cheater ] Miner metadata fetch failed for ${ miner_url }: `, miner_metadata.error )
            return res.status( 500 ).json( { error: `Miner metadata fetch failed for ${ miner_url }, this usually means an out of date miner. Error: ${ miner_metadata.error }`, score: 0, correct: false } )
        }
        const { version='', branch='unknown', hash='unknown' } = miner_metadata
        const miner_version = version.split( '.' ).map( v => parseInt( v, 10 ) )
        const is_miner_version_valid = minimum_version.every( ( value, index ) => ( miner_version[index] || 0 ) >= value )
        if( !is_miner_version_valid ) {
            log.warn( `[POST] [ cheater ] Miner version ${ miner_metadata.version } is not up to date, minimum version is ${ minimum_version.join( '.' ) }` )
            return res.status( 400 ).json( { error: `Miner version ${ miner_metadata.version } is not up to date, minimum version is ${ minimum_version.join( '.' ) }`, score: 0, correct: false } )
        }
        if( branch != 'main' ) warnings.push( `Miner branch is ${ branch }, this is not the main branch. This will be punished soon.` )
        if( hash == 'unknown' ) warnings.push( `Miner commit hash is ${ hash }, this means your miner is misconfigured. This will be punished soon.` )

        // Edge case: cache is not populated yet
        const miner_ip_to_uid_cache_empty = Object.keys( miner_ip_to_uid ).length === 0
        if( miner_ip_to_uid_cache_empty ) {
            miner_uid = claimed_miner_uid
            log.warn( `[POST] [ cheater ] Miner IP to UID cache is empty, using claimed miner uid ${ claimed_miner_uid }` )
        }

        // If the claimed miner uid does not match the expected one, return an error
        if( claimed_miner_uid != miner_uid ) {
            log.info( `[POST] [ cheater ] Miner UID ${ claimed_miner_uid } does not match expected ${ miner_uid }` )
            return res.status( 400 ).json( { error: `Miner UID ${ claimed_miner_uid } does not match expected ${ miner_uid }`, score: 0, correct: false } )
        }

        // Extact wireguard config from request
        const { wireguard_config={} } = req.body || {}
        const { peer_config, peer_id, peer_slots, expires_at } = wireguard_config

        // Validate existence of wireguard config fields
        if( !peer_config || !peer_id || !peer_slots || !expires_at ) {
            log.info( `[POST] [ cheater ] Bad challenge/response ${ challenge }/${ response } with body:`, req.body )
            return res.status( 200 ).json( { error: 'Missing wireguard config fields', score: 0, correct: false } )
        }

        // Validate the challenge solution
        log.info( `[POST] Validating challenge solution for ${ challenge }/${ response }?miner_uid=${ miner_uid }` )
        const { correct, ms_to_solve, solved_at } = await solve_challenge( { challenge, response } )

        // If not correct, return false
        if( !correct ) {
            log.info( `[POST] [ cheater ] Challenge ${ challenge }/${ response } was not solved correctly` )
            return res.json( { correct } )
        }

        // Upon solution success, test the wireguard config
        const { valid: wireguard_valid, message='Unknown error validating wireguard config' } = await validate_wireguard_config( { miner_uid, peer_config, peer_id, miner_ip: unspoofable_ip } )
        if( !wireguard_valid ) {
            log.info( `[POST] [ cheater ] Wireguard config for peer ${ peer_id } failed challenge` )
            return res.json( { message, correct: false, score: 0 } )
        }

        // If correct, score the request
        const { uniqueness_score, country_uniqueness_score, details } = await score_request_uniqueness( req )
        if( uniqueness_score === undefined ) {
            log.info( `[POST] [ cheater ] Uniqueness score is undefined, returning error` )
            return res.status( 200 ).json( { error: 'Nice try', correct: false, score: 0 } )
        }

        // Calculate the score
        log.info( `Time for miner ${ miner_uid } to solve ${ challenge }: ${ ms_to_solve } (${ solved_at })` )
        const { score, speed_score } = calculate_score( { uniqueness_score, ms_to_solve } )

        // Memory cache miner uid score
        let miner_scores = get_tpn_cache( `last_known_miner_scores`, {} )
        const miner_ip_to_country = get_tpn_cache( `miner_ip_to_country`, {} )
        const { country } = miner_ip_to_country[ unspoofable_ip ] || {}
        if( !country ) {
            log.warn( `[POST] [ cheater ] No country found for miner ${ miner_uid } with IP ${ unspoofable_ip }, this indicates either a cheating miner or a misconfigured validator` )
            return res.status( 500 ).json( { error: `No country found for miner ${ miner_uid } with IP ${ unspoofable_ip }`, score: 0, correct: false } )
        }
        miner_scores[ miner_uid ] = { score, timestamp: Date.now(), details, country, ip: unspoofable_ip }
        log.info( `Saving miner ${ miner_uid } score to memory: `, miner_scores[ miner_uid ] )

        // Formulate and cache response
        const data = { correct, score, speed_score, uniqueness_score, country_uniqueness_score, solved_at, miner_uid, warnings }
        cache( `solution_score_${ challenge }`, data )
        
        // Save score to database
        await save_challenge_response_score( { correct, challenge, score, speed_score, uniqueness_score, country_uniqueness_score, solved_at } )
        log.info( `[POST] Challenge ${ challenge } solved with score ${ score }` )


        // Sort the scores by timestamp (latest to oldest)
        // format: { uid: { score, timestamp, details, country, ip } }
        miner_scores = Object.entries( miner_scores )
            .sort( ( a, b ) => b[1].timestamp - a[1].timestamp )
            .map( ( [ uid, miner_entry ] ) => [ uid, { ...miner_entry, timestamp: new Date( miner_entry.timestamp ).toString() } ]  )
            .reduce( ( acc, [ key, value ] ) => ( { ...acc, [ key ]: value } ), {} )
        cache( `last_known_miner_scores`, miner_scores )
        log.info( `[POST] Miner scores updated` )

        const seconds_to_solve = Math.round( ( Date.now() - start ) / 1000 )
        log.info( `[POST] Returning challenge response to ${ miner_uid } for challenge ${ challenge }: `, { ...data, seconds_to_solve } )
        return res.json( data )

    }

    try {

        const retryable_handler = await make_retryable( handle_route, { retry_times: 2, cooldown_in_s: 10, cooldown_entropy: false, logger: log.info } )
        return retryable_handler()
        
    } catch ( e ) {

        log.error( `Error handling challenge/response routes, returning error response. Error:`, e )
        return res.status( 200 ).json( { error: e.message, score: 0, correct: false } )

    }
} )