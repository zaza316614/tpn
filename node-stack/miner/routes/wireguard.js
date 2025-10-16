import { Router } from 'express'
import { log, make_retryable } from 'mentie'
import { get_valid_wireguard_config } from '../modules/wireguard.js'
import { ip_from_req, request_is_local } from '../modules/network.js'
import { is_validator } from '../modules/metagraph.js'
export const router = Router()
const { CI_MODE } = process.env

router.get( '/', ( req, res ) => res.send( 'Wireguard router' ) )

router.get( '/new', async ( req, res ) => {

    // Before anything else, check if this is a call from a validator or local machine
    const is_local = request_is_local( req )
    const validator = is_validator( req )
    const { spoofable_ip, unspoofable_ip } = ip_from_req( req )
    if( !validator && !is_local ) {
        log.info( `Request is not from a validator, nor from local, returning 403` )
        return res.status( 403 ).json( { error: `Only validators may call this endpoint, please read the public API documentation`, spoofable_ip, unspoofable_ip } )
    }
    log.info( `Wireguard config request is from validator ${ validator.uid } with ip ${ validator.ip } (local: ${ is_local })` )


    const handle_route = async () => {

        // Get properties from query string, note that geo query is just for debug info as we cannot change it here
        const { geo='any', lease_minutes } = req.query
        log.info( `Received request for new wireguard config with geo ${ geo } and lease_minutes ${ lease_minutes }` )

        // Check if properties are valid
        if( !geo || !lease_minutes ) return res.status( 400 ).json( { error: 'Missing geo or lease_minutes' } )

        // Convert lease_minutes to number and validate
        const lease_minutes_num = parseFloat( lease_minutes )
        if( isNaN( lease_minutes_num ) ) return res.status( 400 ).json( { error: 'lease_minutes must be a valid number' } )

        // Lease must be between 5 and 60 minutes
        const lease_min = CI_MODE ? .1 : .5
        const lease_max = 60
        if( lease_min > lease_minutes_num || lease_minutes_num > lease_max ) return res.status( 400 ).json( { error: `Lease must be between ${ lease_min } and ${ lease_max } minutes` } )
        
        // Get a valid WireGuard configuration, note: this endpoint should never receive the validator-dedicated files (used for challenge-response), so we are NOT setting the validator property
        const { peer_config, peer_id, peer_slots, expires_at } = await get_valid_wireguard_config( { validator: null, lease_minutes: lease_minutes_num } )

        return res.json( { peer_slots, peer_config, peer_id, expires_at } )

    }

    try {

        const retry_times = CI_MODE ? 1 : 2
        const retryable_handler = await make_retryable( handle_route, { retry_times, cooldown_in_s: 2, cooldown_entropy: true } )
        return retryable_handler()

    } catch ( error ) {
        log.error( `Error in wireguard /new: ${ error }` )
        return res.status( 500 ).json( { error: 'Internal server error' } )
    }

} )

