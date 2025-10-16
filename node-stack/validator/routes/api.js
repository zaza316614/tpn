import { Router } from "express"
export const router = Router()
import { log, require_props, sanetise_string } from "mentie"
import fetch from "node-fetch"
import { get_ips_by_country, get_miner_statuses } from "../modules/stats.js"
import { code_to_country, country_to_code } from "../modules/countries.js"
import { get_tpn_cache } from "../modules/caching.js"

router.get( "/config/countries", async ( req, res ) => {

    try {

        // Check if get parameter is ?format=code or ?format=name
        const { format='code' } = req.query

        // Get current country code to name mapping
        const country_code_to_name = get_tpn_cache( 'miner_country_code_to_name', {} )

        // Get the country code to miner uid mapping, and cross reference it with the last known miner statuses, so we can make a list of countries without miners whose status is not 'online'
        // const miner_uids = get_tpn_cache( 'miner_uids', [] )
        const country_to_uids = get_tpn_cache( 'miner_country_to_uids', {} )
        const miner_statuses = await get_miner_statuses()
        
        // Find countries with no online miners
        const defunct_country_codes = Object.keys( country_to_uids ).filter( country_code => {

            // Get the uids for this country code
            const uids = country_to_uids[ country_code ] || []

            // If there are no uids, this country is defunct
            if( uids.length == 0 ) return true

            // If there are uids, check if any of them are online
            const has_online_uid = uids.some( uid => {
                const status = miner_statuses[ uid ]
                return status && status.status == 'online'
            } )

            // If there are no online uids, this country is defunct
            return !has_online_uid

        } )

        // Remove defunct countries from the country code to name mapping
        const online_country_code_to_name = defunct_country_codes.reduce( ( acc, country_code ) => {

            // Delete country code from the mapping
            delete acc[ country_code ]
            return acc

        }, { ...country_code_to_name } )

        // Translate to country code array
        let response_data = []
        if( format == 'name' ) response_data = Object.values( online_country_code_to_name )
        if( format == 'code' ) response_data = Object.keys( online_country_code_to_name )
        return res.json( response_data )
        
    } catch ( e ) {

        log.error( e )
        return res.status( 500 ).json( { error: e.message } )

    }

} )

router.get( '/config/new', async ( req, res ) => {

    try {

        // Get request parameters
        let { geo, lease_minutes, format='json', timeout_ms=5_000, trace=false } = req.query
        log.info( `Request received for new config:`, { geo, lease_minutes } )

        // Validate request parameters
        const required_properties = [ 'geo', 'lease_minutes' ]
        require_props( req.query, required_properties )
        log.info( `Request properties validated` )

        // Validate lease
        const lease_min = .5
        const lease_max = 60
        if( lease_minutes < lease_min || lease_minutes > lease_max ) {
            throw new Error( `Lease must be between ${ lease_min } and ${ lease_max } minutes, you supplied ${ lease_minutes }` )
        }

        // If geo was set to 'any', set it to null
        if( geo == 'any' ) geo = null

        // If geo was provided, uppercase it
        if( geo ) geo = sanetise_string( geo ).toUpperCase()

        // Check if this geo translates to a known country name, if not, check if it is a name to be translated to a geo
        const country_name = code_to_country( geo )
        if( !country_name ) {
            const country_code = country_to_code( geo )
            if( country_code ) geo = country_code
        }

        // Dummy response
        const live = true
        if( !live ) {
            return res.json( { error: 'Endpoint not yet enabled, it will be soon', your_inputs: { geo, lease_minutes } } )
        }

        // Get the miner ips for this country code
        const ips = await get_ips_by_country( { geo } )
        log.info( `Got ${ ips.length } ips for country:`, geo )

        // If there are no ips, return an error
        if( ips.length == 0 ) return res.status( 404 ).json( { error: `No ips found for country: ${ geo }` } )

        // Request configs from these miners until one succeeds
        let config = null
        const errors = []
        for( let ip of ips ) {

            log.info( `Requesting config from miner:`, ip )

            // Sanetise potential ipv6 mapping of ipv4 address
            if( ip?.trim()?.startsWith( '::ffff:' ) ) ip = ip?.replace( '::ffff:', '' )

            // Create the config url
            let config_url = new URL( `http://${ ip }:3001/wireguard/new` )
            config_url.searchParams.set( 'lease_minutes', lease_minutes )
            config_url.searchParams.set( 'geo', geo )
            config_url = config_url.toString()
            log.info( `Requesting config from:`, config_url )

            // Response holder for trycatch management
            let response = undefined

            try {

                // Request with timeout
                const controller = new AbortController()
                const timeout_id = setTimeout( () => {
                    controller.abort()
                }, timeout_ms )
                response = await fetch( config_url, { signal: controller.signal } )
                clearTimeout( timeout_id )

                const json = await response.clone().json()
                log.info( `Response from ${ ip }:`, json )

                // Get relevant properties
                const { peer_config, expires_at } = json
                if( peer_config && expires_at ) config = { peer_config, expires_at }

                // If we have a config, exit the for loop
                if( config ) break

            } catch ( e ) {

                const text_response = await response?.clone()?.text()?.catch( e => e.message )
                log.info( `Error requesting config from ${ ip }: ${ e.message }. Response body:`, text_response )
                errors.push( { ip, error: e.message, response: text_response } )

                continue

            }


        }

        // If no config was found, return an error 
        if( !config ) return res.status( 404 ).json( {
            error: `No config found for country: ${ geo } (${ ips.length } miners)`,
            ...trace ? { errors } : {}
        } )
        log.info( `Config found for ${ geo }:`, config )

        // Return the config to the requester
        if( format == 'json' ) return res.json( { ...config } )
        return res.send( config.peer_config )


    } catch ( e ) {

        log.info( `Error requesting config:`, e.message )
        return res.status( 400 ).json( { error: e.message } )

    }

} )
