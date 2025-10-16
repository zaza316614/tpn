import { log } from 'mentie'
import { is_data_center } from './ip2location.js'
import { fetch_failover_stats } from './stats.js'
import { ip_from_req } from "./network.js"
import { get_tpn_cache } from './caching.js'
const { CI_MODE } = process.env

async function score_ip_uniqueness( ip ) {

    // Retreive relevant cache data
    let miner_ip_to_country = get_tpn_cache( `miner_ip_to_country`, {} )
    let miner_country_count = get_tpn_cache( `miner_country_count`, {} )

    // If either of the cache have 0 keys, grab failover data
    if( !Object.keys( miner_ip_to_country ).length || !Object.keys( miner_country_count ).length ) {
        
        log.info( `Missing miner data in cache, using failover` )
        const data = await fetch_failover_stats()

        if( !Object.keys( miner_ip_to_country ).length ) miner_ip_to_country = data.miner_ip_to_country
        if( !Object.keys( miner_country_count ).length ) miner_country_count = data.miner_country_count

        log.info( `Miner ip to country cache:`, miner_ip_to_country )
        log.info( `Miner country count cache:`, miner_country_count )

    }

    // Get the geolocation of this ip
    let { country } = miner_ip_to_country[ ip ] || {}
    log.info( `Request from:`, country )

    // If country is missing, try to resolve it once more
    if( !country ) {
        try {
            const { default: geoip } = await import( 'geoip-lite' )
            const { country: new_country } = geoip.lookup( ip ) || {}
            if( new_country ) {
                log.info( `GeoIP lookup for ${ ip } returned ${ new_country }` )
                country = new_country
            }
        } catch ( e ) {
            log.error( `Error looking up country for ip ${ ip }`, e )
        }
    }

    // Get country counts
    const miner_count = Object.keys( miner_ip_to_country ).length
    const country_count = miner_country_count[ country ] || 0
    const miners_in_same_country = miner_country_count[ country ] || 0
    const ip_pct_same_country = Math.round( miners_in_same_country / miner_count  * 100 )

    // Calculate the average number of miners in a country
    const average_miners_in_country = Math.round( miner_count / Object.keys( miner_country_count ).length )
    log.info( `Average miners in country: ${ average_miners_in_country }` )

    // Get the connection type
    const is_dc = await is_data_center( ip )

    // Calcluate the score of the request, datacenters get half scores
    const datacenter_penalty = 0.9
    let country_uniqueness_score = ( 100 - ip_pct_same_country ) * ( is_dc ? datacenter_penalty : 1 )
    if( country_count <= 1 ) {
        log.info( `There is only one country in the database, force-setting country uniqueness to 100`  )
        country_uniqueness_score = 100
    }
    log.info( `Country uniqueness: ${ country_uniqueness_score }` )

    // Curve score with a power function where 100 stays 100, but lower numbers get more extreme
    const curve = 5
    const powered_score = Math.pow( country_uniqueness_score / 100, curve ) * 100
    log.info( `Powered score: ${ powered_score }` )

    // Score details
    const details = {
        is_dc,
        ip_pct_same_country,
        country_count,
        miners_in_same_country,
        average_miners_in_country
    }

    // Return the score of the request
    return { powered_score, country_uniqueness_score, country, details }
    
}



/**
 * Scores the uniqueness of a request based on its IP address.
 *
 * @param {Object} request - The request object.
 * @param {string} request.ip - The IP address of the request.
 * @param {string[]} request.ips - The array of IP addresses in  the request.
 * @param {Object} request.connection - The connection object of the request.
 * @param {Object} request.socket - The socket object of the request.
 * @param {Function} request.get - Function to get headers from the request.
 * @returns {Promise<Object|undefined>} scores_data - Returns an object containing the uniqueness score and country uniqueness score if successful, otherwise undefined.
 * @returns {number} scores_data.uniqueness_score - The uniqueness score of the request.
 * @returns {number} scores_data.country_uniqueness_score - The country uniqueness score of the request.
 * @returns {string} scores_data.country - The country of the request.
 * @returns {Object} scores_data.details - Additional details about the request.
 */
export async function score_request_uniqueness( request ) {

    // Get the ip of the originating request
    let { unspoofable_ip, spoofable_ip } = ip_from_req( request )

    // Log out the ip address of the request
    if( unspoofable_ip ) log.info( `Request from ${ unspoofable_ip }` )
    if( !unspoofable_ip ) {
        log.info( `Cannot determine ip address of request, but it might be coming from ${ spoofable_ip } based on headers alone` )
        // return undefined so the calling parent knows there is an issue
        return { uniqueness_score: undefined }
    }

    // Get the score of this ip
    const { powered_score, country_uniqueness_score, country, details } = await score_ip_uniqueness( unspoofable_ip )

    // If country was undefined, exit with undefined score
    if( !country && !CI_MODE ) {
        log.info( `Cannot determine country of request` )
        return { uniqueness_score: undefined }
    }

    // Return the score of the request
    return { uniqueness_score: powered_score, country_uniqueness_score, details }

}

// Datacenter name patterns (including educated guesses)
export const datacenter_patterns = [
    /amazon/i,
    /aws/i,
    /cloudfront/i,
    /google/i,
    /microsoft/i,
    /azure/i,
    /digitalocean/i,
    /linode/i,
    /vultr/i,
    /ovh/i,
    /hetzner/i,
    /upcloud/i,
    /scaleway/i,
    /contabo/i,
    /ionos/i,
    /rackspace/i,
    /softlayer/i,
    /alibaba/i,
    /tencent/i,
    /baidu/i,
    /cloudflare/i,
    /fastly/i,
    /akamai/i,
    /edgecast/i,
    /level3/i,
    /limelight/i,
    /incapsula/i,
    /stackpath/i,
    /maxcdn/i,
    /cloudsigma/i,
    /quadranet/i,
    /psychz/i,
    /choopa/i,
    /leaseweb/i,
    /hostwinds/i,
    /equinix/i,
    /colocrossing/i,
    /hivelocity/i,
    /godaddy/i,
    /bluehost/i,
    /hostgator/i,
    /dreamhost/i,
    /hurricane electric/i,
    // Generic patterns indicating data centers
    /colo/i,
    /datacenter/i,
    /serverfarm/i,
    /hosting/i,
    /cloud\s*services?/i,
    /dedicated\s*server/i,
    /vps/i
]