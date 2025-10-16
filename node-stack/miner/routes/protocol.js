import { Router } from "express"
import { cache, is_ipv4, log, make_retryable, require_props, sanetise_ipv4 } from "mentie"
import { request_is_local } from "../modules/network.js"
import { get_complete_tpn_cache, save_tpn_cache_to_disk } from "../modules/caching.js"
import { validators_ip_fallback } from "../modules/metagraph.js"
export const router = Router()

/**
 * Route to handle neuron broadcasts
 * @params {Object} req.body.neurons - Array of neuron objects with properties: uid, ip, validator_trust, trust, stake, block, hotkey, coldkey, balance
 */
router.post( "/broadcast/neurons", async ( req, res ) => {

    if( !request_is_local( req ) ) return res.status( 403 ).json( { error: `Request not from localhost` } )

    const handle_route = async () => {

        // Get neurons from the request
        const { neurons=[] } = req.body || {}

        // Validate that all properties are present
        let valid_entries = neurons.filter( entry => require_props( entry, [ 'uid', 'ip', 'validator_trust', 'trust', 'alpha_stake', 'stake_weight', 'block', 'hotkey', 'coldkey' ], false ) )
        log.info( `Valid neuron entries: ${ valid_entries.length } of ${ neurons.length }, sample: `, valid_entries.slice( 0, 5 ) )

        // Sanetise the entry data
        valid_entries = valid_entries.map( entry => {
            const { uid, validator_trust, alpha_stake, stake_weight } = entry
            let { ip } = entry

            // If null ip check if we have fallback
            if( ip == '0.0.0.0' ) ip = validators_ip_fallback[ uid ]?.ip || ip
            
            return {
                uid: Number( uid ),
                ip: sanetise_ipv4( { ip, validate: true } ) || '0.0.0.0',
                validator_trust: Number( validator_trust ),
                alpha_stake: Number( alpha_stake ),
                stake_weight: Number( stake_weight )
            }
        } )

        // If there are no valid entries, throw an error
        if( valid_entries.length == 0 ) throw new Error( `No valid neurons provided` )

        // Split the validators, miners, and weight copiers
        const { validators=[], miners=[], weight_copiers=[], excluded=[] } = valid_entries.reduce( ( acc, entry ) => {

            const { validator_trust=0, ip, excluded=false } = entry
            const zero_ip = ip == '0.0.0.0'
            const valid_ip = is_ipv4( ip ) && !zero_ip

            // If the entry is excluded, skip it
            if( excluded ) {
                acc.excluded.push( entry )
                return acc
            }

            // If you have validator trust, you are a validator or weight copier
            if( validator_trust > 0 ) {

                // If you have a valid ip, you are a validator
                if( valid_ip ) acc.validators.push( entry )
                // If you have no valid ip, you are a weight copier
                else acc.weight_copiers.push( entry )

                return acc
            }

            // If you have no validator trust, but a valid ip, you are a miner
            if( valid_ip ) acc.miners.push( entry )

            return acc

        }, { validators: [], miners: [], weight_copiers: [], excluded: [] } )

        log.info( `Found ${ validators.length } validators, ${ miners.length } miners, ${ excluded.length } excluded, and ${ weight_copiers.length } weight copiers` )

        // ///////////////////////////
        // 🤖 Cache validators to memory
        // ///////////////////////////
        log.info( `Caching validator ip data: `, validators )
        cache( 'last_known_validators', validators )

        // Persist cache to disk
        await save_tpn_cache_to_disk()

        // Return some stats
        return res.json( {
            validators: validators.length,
            miners: miners.length,
            weight_copiers: weight_copiers.length,
            success: true,
        } )

    }

    try {

        const retryable_handler = await make_retryable( handle_route, { retry_times: 2, cooldown_in_s: 10, cooldown_entropy: false } )
        return retryable_handler()
        
    } catch ( e ) {
        
        log.warn( `Error handling neuron broadcast. Error:`, e )
        return res.status( 200 ).json( { error: e.message } )

    }

} )


/**
 * Route to handle stats submitted from the neuron
 */
router.get( "/sync/stats", ( req, res ) => {

    // Get tpn cache
    const tpn_cache = get_complete_tpn_cache()

    return res.json( tpn_cache )

} )