import { log } from "mentie"

export function ip_from_req( request ) {
    // Extract the ip address from the request object
    let { ip: request_ip, ips, connection, socket } = request

    // If the request has no ips, use the connection or socket remote address
    let spoofable_ip = request_ip || ips[0] || request.get( 'x-forwarded-for' )

    // Grab the remote address from the connection or socket
    let unspoofable_ip = connection.remoteAddress || socket.remoteAddress

    // If unspoofable ip is a ipv6 address with a v4-mapped prefix, remove it
    unspoofable_ip = unspoofable_ip?.replace( '::ffff:', '' )
    spoofable_ip = spoofable_ip?.replace( '::ffff:', '' )
    
    return { unspoofable_ip, spoofable_ip }
}

export function request_is_local( request ) {

    // Get the ip of the originating request
    const { unspoofable_ip, spoofable_ip } = ip_from_req( request )

    // Log out the ip address of the request
    if( unspoofable_ip ) log.info( `Request from ${ unspoofable_ip }` )
    if( !unspoofable_ip ) {
        log.info( `Cannot determine ip address of request, but it might be coming from ${ spoofable_ip } based on headers alone` )
        // Assume remote when unknown
        return false
    }

    // Check if the ip is local
    const local_ip_patterns_v4_and_v6 = [
        // Localhost
        /^127\.0\.0\.1$/,
        /^::1$/,
        /^::ffff:127\.0\.0\.1$/,
        // Note: this is the ipv6 mock mask of the subnet defined in validator.docker-compose.yml
        /^172\.29\.187\./,
        /^::ffff:172\.29\.187\./,
    ]
    const is_local = local_ip_patterns_v4_and_v6.some( pattern => pattern.test( unspoofable_ip ) )   
    
    return is_local

}