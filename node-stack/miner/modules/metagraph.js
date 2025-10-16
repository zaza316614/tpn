import { cache, log } from "mentie"
import { ip_from_req } from "./network.js"
import { exec } from "child_process"
const { CI_MODE } = process.env

// This hardcoded validator list is a failover for when the neuron did not submit the latest validator ips
export const validators_ip_fallback = [

    // Live validators as on https://taostats.io/subnets/65/metagraph?order=stake%3Adesc
    { uid: 117, ip: '34.130.144.244' },
    { uid: 4, ip: '88.204.136.220' },
    { uid: 0, ip: '46.16.144.134' },
    { uid: 47, ip: '161.35.91.172' },
    { uid: 181, ip: '192.150.253.122' },

]

// Manual overrise for ips that should be considered validators for the purpose of miner API requests
export const validators_ip_overrides = [ '46.16.144.134', '88.204.136.220', '161.35.91.172' ]


export function validator_count() {
    // Remove testnet validators and return count
    return validator_ips().length
}

/**
 * Get valid validator IPs.
 *
 * Retrieves validators from cache or uses fallback.
 * If an IP is '0.0.0.0', it replaces it with the fallback value.
 * Returns an array of valid IP addresses.
 *
 * @returns {string[]} Valid IP addresses.
 */
export function validator_ips() {

    // Check if validators are in cache, use it if so and fall back to hardcoded list if not
    const cached_validators = cache( 'last_known_validators' )
    const validators_to_use = cached_validators || validators_ip_fallback

    // For all validators to use, check that their ip is not 0.0.0.0, if it is override with hardcoded list above
    const sane_validators = validators_to_use.map( ( { ip, uid } ) => {
        let validator = { ip, uid }
        if( validator.ip == '0.0.0.0' ) {
            log.warn( `Validator ${ validator.uid } has ip 0.0.0.0, using hardcoded list instead` )
            validator.ip = validators_ip_fallback.find( val => val.uid == validator.uid )?.ip || '0.0.0.0'
        }
        return validator
    } )
    
    // Remove testnet validators and 0.0.0.0 entries
    const validator_ips = sane_validators.filter( ( { uid, ip } ) => uid !== null && ip != '0.0.0.0' ).map( ( { ip } ) => ip )
    return validator_ips
}

/**
 * Check if the request comes from a validator.
 *
 * Returns a mock validator in CI mode, or verifies the request's IP against known validators.
 *
 * @param {Object} request - The request object.
 * @returns {(Object|boolean)} - Validator object if matched, otherwise false.
 */
export function is_validator( request ) {

    // In CI mode, bypass this check
    if( CI_MODE ) {
        log.info( `CI_MODE is enabled, bypassing validator check` )
        return { uid: Infinity, ip: 'mock.mock.mock.mock' }
    }

    // Get the ip of the originating request
    const { spoofable_ip, unspoofable_ip } = ip_from_req( request )
    log.info( `Request ip: ${ unspoofable_ip } (spoofable: ${ spoofable_ip } )` )

    // Check if input is ipv4 (very naively)
    const is_ipv4 = unspoofable_ip.match( /\d*.\d*.\d*.\d*/ )
    if( !is_ipv4 ) return false

    // Find first matching validator
    const validator = validator_ips().find( ip => ip === unspoofable_ip )

    // Check if ip is override ip
    if( validators_ip_overrides.includes( unspoofable_ip ) ) {
        log.info( `Request ip ${ unspoofable_ip } is an override ip` )
        return { uid: Infinity, ip: unspoofable_ip }
    }

    return validator || false

}


/**
 * Get current Git branch and short commit hash.
 * @returns {Promise<{ branch: string, hash: string }>} An object containing the branch name and short commit hash.
 */
export async function get_git_branch_and_hash() {
    try {
        const branch = await new Promise( ( resolve, reject ) => {
            exec( 'git rev-parse --abbrev-ref HEAD', ( error, stdout ) => {
                if( error ) return reject( error )
                resolve( stdout.trim() )
            } )
        } )
        const hash = await new Promise( ( resolve, reject ) => {
            exec( 'git rev-parse --short HEAD', ( error, stdout ) => {
                if( error ) return reject( error )
                resolve( stdout.trim() )
            } )
        } )
        return { branch, hash }
    } catch ( e ) {
        log.error( `Failed to get git branch and hash: ${ e.message }` )
        return { branch: 'unknown', hash: 'unknown' }
    }
}