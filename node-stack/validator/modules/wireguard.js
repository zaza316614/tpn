import { cache, log, random_number_between, random_string_of_length, wait } from "mentie"
import { generate_challenge, solve_challenge } from "./challenge.js"
import { run } from "./shell.js"
import { base_url } from "./url.js"
import { save_miner_status } from "./database.js"

// Timeout used for curl commands
const { CI_MODE } = process.env
const test_timeout_seconds = CI_MODE ? 10 : 30

// Split multi-line commands into an array of commands
const split_ml_commands = commands => commands.split( '\n' ).map( c => c.replace( /#.*$/gm, '' ) ).filter( c => c.trim() ).map( c => c.trim() )

/**
 * Waits for a given IP address to become free (not in use) within a specified timeout period.
 * @param {Object} options - The options for the function.
 * @param {string} options.ip_address - The IP address to check.
 * @param {number} [options.timeout=test_timeout_ms] - The maximum time to wait for the IP address to become free, in milliseconds.
 * @throws {Error} Throws an error if no IP address is provided.
 * @returns {Promise<boolean>} Resolves to `true` if the IP address becomes free within the timeout, or `false` if it remains in use.
 */
export async function wait_for_ip_free( { ip_address, timeout_s=test_timeout_seconds, log_tag=Date.now(), verbose=false } ) {

    log.info( log_tag, `Waiting for IP address ${ ip_address } to become free` )

    // Check if the ip address is valid
    if( !ip_address ) throw new Error( `No ip address provided` )

    // Check the cache for the ip address being in process
    let ip_being_processed = cache( `ip_being_processed_${ ip_address }` )

    // Check if the ip address is already in use
    const { stdout, stderr } = await run( `ip addr show | grep ${ ip_address } || true`, { silent: !verbose, verbose, log_tag } )
    let ip_taken = stdout?.includes( ip_address )

    // If ip not taken, return out
    if( !ip_taken ) {
        log.info( log_tag, `IP address ${ ip_address } is free, no need to wait` )
        return true
    }

    // If ip is taken, wait for it to be free
    let waited_for = 0
    const timeout = timeout_s * 1000
    const interval = 5000
    while( ip_taken && waited_for < timeout ) {
        log.info( log_tag, `[WHILE] IP address ${ ip_address } is in use, waiting ${ interval / 1000 }s (waited for ${ waited_for / 1000 }s) for it to become free...` )
        await wait( interval )
        waited_for += interval

        // Check on interface level
        const { stdout, stderr } = await run( `ip addr show | grep ${ ip_address } || true`, { silent: !verbose } )

        // Check on cache level
        ip_being_processed = cache( `ip_being_processed_${ ip_address }` )

        ip_taken = stdout?.includes( ip_address ) || ip_being_processed
        if( !ip_taken ) break
    }

    // If ip is still taken, return false
    if( ip_taken ) {
        log.warn( log_tag, `IP address ${ ip_address } is still in use after ${ waited_for / 1000 } seconds` )
        return false
    }
    log.info( log_tag, `IP address ${ ip_address } is free after ${ waited_for / 1000 } seconds` )
    return true

}

export async function clean_up_tpn_namespaces( { namespaces }={} ) {

    log.info( `Cleaning up ${ namespaces?.length || 'all' } namespaces` )

    // Get all namespaces
    if( !namespaces ) {
        log.info( `No namespaces provided, getting all namespaces` )
        const { stdout } = await run( `ip netns list`, { silent: true } )
        namespaces = stdout?.split( '\n' ).filter( line => line.includes( 'tpn' ) ).map( line => line.split( ':' )[ 0 ].trim() )   
        log.info( `Found TPN namespaces:`, namespaces )
    }

    // If no namespaces found, return
    if( !namespaces || !namespaces?.length ) {
        log.info( `No namespaces found to clean up` )
        return false
    }

    // Loop over namespaces and delete them
    log.info( `Deleting ${ namespaces?.length } namespaces` )
    for( const namespace_id of namespaces ) {
        log.info( `Cleaning up namespace ${ namespace_id }` )
        await run( `ip netns del ${ namespace_id }`, { silent: true } )
        log.info( `Deleted namespace ${ namespace_id }` )
    }

    return !!namespaces?.length

}

/**
 * Cleans up TPN interfaces by deleting their links, routing tables, 
 * and configuration files. Can operate in dry-run mode to simulate the cleanup process.
 *
 * @param {Object} [options={}] - The options for the cleanup process.
 * @param {string[]} [options.interfaces] - The list of interface names to clean up. If not provided, all TPN interfaces will be targeted.
 * @param {string[]} [options.ip_addresses] - The list of IP addresses to find associated interfaces for cleanup.
 * @param {boolean} [options.dryrun=false] - If true, the cleanup process will only log actions without making changes.
 * @returns {Promise<boolean>} - Returns `true` if any interfaces were cleaned up, otherwise `false`.
 */
export async function clean_up_tpn_interfaces( { interfaces, ip_addresses, dryrun=false }={} ) {

    log.info( `Cleaning up ${ interfaces?.length || 'all' } interfaces` )

    // Get all interfaces
    if( !interfaces && !ip_addresses ) {
        log.info( `No interfaces provided, getting all interfaces` )
        const { stdout } = await run( `ip link show`, { silent: false } )
        interfaces = stdout?.split( '\n' ).filter( line => line.includes( 'tpn' ) ).map( line => line.split( ':' )[ 1 ].trim() )   
        log.info( `Found TPN interfaces:`, interfaces )
    }

    // Get all interfaces associated with the ip addresses
    if( ip_addresses ) {
        log.info( `Getting all interfaces associated with ip addresses:`, ip_addresses )
        const interfaces_of_ips = await Promise.all( ip_addresses.map( ip => {
            const { stdout } = run( `ip addr show | grep ${ ip } | awk -F' ' '{print $2}'` )
            if( stdout?.includes( 'tpn' ) ) return stdout?.trim()
            return null
        } ) ).split( '\n' ).filter( line => line?.includes( 'tpn' ) ).trim()
        log.info( `Found interfaces associated with ip addresses:`, interfaces_of_ips )
        interfaces = interfaces ? [ ...interfaces, ...interfaces_of_ips ] : interfaces_of_ips
    }

    // If no interfaces found, return
    if( !interfaces || !interfaces?.length ) {
        log.info( `No interfaces found to clean up` )
        return false
    }

    // Loop over interfaces and delete them, their routing tables, and their config file
    log.info( `Deleting ${ interfaces?.length } interfaces` )
    for( const interface_id of interfaces ) {
        if( dryrun ) {
            log.info( `Dryrun enabled, not deleting interface ${ interface_id }` )
            continue
        }
        log.info( `Cleaning up interface ${ interface_id } link, route, config` )
        await run( `ip link delete ${ interface_id }`, { silent: true } )
        await run( `ip route flush table ${ interface_id }`, { silent: true } )
        await run( `rm -f /tmp/${ interface_id }.conf`,  { silent: true } )
        log.info( `Deleted interface ${ interface_id } and all associated entries` )
    }

    return !!interfaces?.length

}

/**
 * Validate a wireguard config by running it and checking the response of a challenge hosted on this machine
 * @param {Object} params
 * @param {string} params.miner_uid - The uid of the miner to validate the wireguard config for
 * @param {string} params.peer_config - The wireguard config to validate
 * @param {string} params.peer_id - The peer id to use for logging
 * @returns {Object} - The result of the validation
 * @returns {boolean} result.valid - Whether the wireguard config is valid
 * @returns {string} result.message - The message to return
 */
export async function validate_wireguard_config( { miner_uid, peer_config, peer_id, miner_ip, verbose=false } ) {

    const log_tag = `[ ${ peer_id }_${ Date.now() } ]`

    // Validate the wireguard config
    if( !peer_config ) return { valid: false, message: `No wireguard config provided` }
    const expected_props = [ '[Interface]', '[Peer]', 'Address', 'PrivateKey', 'ListenPort', 'PublicKey', 'PresharedKey', 'AllowedIPs', 'Endpoint' ]
    const missing_props = expected_props.filter( prop => !peer_config.includes( prop ) )
    if( missing_props.length ) {
        log.warn( `${ log_tag } Wireguard config for peer ${ peer_id } is missing required properties:`, missing_props )
        await save_miner_status( { miner_uid, status: 'misconfigured' } )
        return { valid: false, message: `Wireguard config for peer ${ peer_id } is missing required properties: ${ missing_props.join( ', ' ) }` }
    }
    
    // Generate a challenge on this machine
    // const { CI_MODE, CI_IP, PUBLIC_VALIDATOR_URL } = process.env
    // let [ ci_ip ] = CI_IP.split( '\n' ).filter( ip => ip.trim() ) || []
    // const base_url = CI_MODE ? `http://${ ci_ip }:3000` : PUBLIC_VALIDATOR_URL
    const challenge = await generate_challenge( { miner_uid }  )
    const challenge_url = `${ base_url }/challenge/${ challenge }`

    // The peer_config in CI mode uses SERVERURL=miner, we should resolve that within this container because namespaces cannot use the docker DNS resolver
    // if( CI_MODE ) {
    //     log.info( `Replacing miner with ${ ci_ip } in peer_config` )
    //     peer_config = peer_config.replace( 'miner', ci_ip )
    //     log.info( `Peer config after replacement:` )
    // }

    // Run specific variables
    let interface_id = `tpn${ peer_id }${ random_string_of_length( 5 ) }`
    let veth_id = `tpn${ random_string_of_length( 5 ) }`
    let veth_subnet_prefix = `10.200.${ random_number_between( 1, 254 ) }`
    const config_path = `/tmp/${ interface_id }.conf`
    let { stdout: default_route } = await run( `ip route show default | awk '/^default/ {print $3}'`, { silent: !verbose, log_tag } )
    default_route = default_route.trim()
    let namespace_id = `ns_${ interface_id }`
    if( verbose ) log.info( `${ log_tag } Default route:`, default_route )

    // Make sure there are no duplicates
    let interface_id_in_use = cache( `interface_id_in_use_${ interface_id }` )
    let veth_id_in_use = cache( `veth_id_in_use_${ veth_id }` )
    let namespace_id_in_use = cache( `namespace_id_in_use_${ namespace_id }` )
    let veth_subnet_prefix_in_use = cache( `veth_subnet_prefix_in_use_${ veth_subnet_prefix }` )
    let attempts = 1
    const max_attempts = 60
    while( interface_id_in_use || veth_id_in_use || namespace_id_in_use || veth_subnet_prefix_in_use ) {

        log.info( `[WHILE] Checking for free interfaces, veth, namespace, subnet prefix` )

        // If we have exceeded the max attempts, something is very wrong, error
        if( attempts > max_attempts ) {
            log.error( `${ log_tag } Exceeded max attempts to generate unique ids for peer ${ peer_id }, trace: `, {
                interface_id_in_use,
                veth_id_in_use,
                namespace_id_in_use,
                veth_subnet_prefix_in_use,
                interface_id,
                veth_id,
                namespace_id,
                veth_subnet_prefix,
                attempts,
            } )
            throw new Error( `Exceeded max attempts to generate unique ids for peer ${ peer_id }` )
        }

        if( verbose ) log.info( `${ log_tag } Collision in ids found: `, {
            interface_id_in_use,
            veth_id_in_use,
            namespace_id_in_use,
            veth_subnet_prefix_in_use,
            interface_id,
            veth_id,
            namespace_id,
        } )
        if( interface_id_in_use ) {
            const new_interface_id = `tpn${ peer_id }${ random_string_of_length( 5 ) }`
            log.info( `${ log_tag } Regenerating interface_id from ${ interface_id } to ${ new_interface_id }` )
            interface_id = new_interface_id
            interface_id_in_use = cache( `interface_id_in_use_${ interface_id }` )
        }
        if( veth_id_in_use ) {
            const new_veth_id = random_string_of_length( 5 )
            log.info( `${ log_tag } Regenerating veth_id from ${ veth_id } to ${ new_veth_id }` )
            veth_id = new_veth_id
            veth_id_in_use = cache( `veth_id_in_use_${ veth_id }` )
        }
        if( namespace_id_in_use ) {
            const new_namespace_id = `ns_${ interface_id }`
            log.info( `${ log_tag } Regenerating namespace_id from ${ namespace_id } to ${ new_namespace_id }` )
            namespace_id = new_namespace_id
            namespace_id_in_use = cache( `namespace_id_in_use_${ namespace_id }` )
        }
        if( veth_subnet_prefix_in_use ) {
            const new_veth_subnet_prefix = `10.200.${ random_number_between( 1, 254 ) }`
            log.info( `${ log_tag } Regenerating veth_subnet_prefix from ${ veth_subnet_prefix } to ${ new_veth_subnet_prefix }` )
            veth_subnet_prefix = new_veth_subnet_prefix
            veth_subnet_prefix_in_use = cache( `veth_subnet_prefix_in_use_${ veth_subnet_prefix }` )
        }

        if( verbose ) log.info( `${ log_tag } Trace of ids: `, {
            interface_id,
            veth_id,
            namespace_id,
            veth_subnet_prefix,
            interface_id_in_use,
            veth_id_in_use,
            namespace_id_in_use,
            veth_subnet_prefix_in_use
        } )

        // Add a tiny delay to prevent possible OOM when this logic fails for some reason
        const wait_time = attempts * 1000
        log.info( `${ log_tag } Waiting ${ wait_time }ms before next attempt to generate unique ids for peer ${ peer_id }` )
        await wait( wait_time )
        attempts++

    }

    // Mark the ids as in use
    cache( `interface_id_in_use_${ interface_id }`, true, 120_000 )
    cache( `veth_id_in_use_${ veth_id }`, true, 120_000 )
    cache( `namespace_id_in_use_${ namespace_id }`, true, 120_000 )
    cache( `veth_subnet_prefix_in_use_${ veth_subnet_prefix }`, true, 120_000 )

    // Get the endpoint host from the config
    let { 1: endpoint } = peer_config.match( /Endpoint ?= ?(.*)/ ) || []
    endpoint = `${ endpoint }`.trim().split( ':' )[ 0 ]
    if( verbose ) log.info( `${ log_tag } Parsed endpoint from wireguard config for peer ${ peer_id }:`, endpoint )

    // Get the address from the config
    let { 1: address } = peer_config.match( /Address ?= ?(.*)/ ) || []
    address = `${ address }`.split( '/' )[ 0 ]
    if( verbose ) log.info( `${ log_tag } Parsed address from wireguard config for peer ${ peer_id }:`, address )


    // Create cache clearing helper
    const clear_id_caches = () => {

        // Mark ids and ip as free again
        if( verbose ) log.info( `${ log_tag } Marking ids and ip ${ address } as free again` )
        cache( `interface_id_in_use_${ interface_id }`, false )
        cache( `veth_id_in_use_${ veth_id }`, false )
        cache( `namespace_id_in_use_${ namespace_id }`, false )
        cache( `veth_subnet_prefix_in_use_${ veth_subnet_prefix }`, false )
        cache( `ip_being_processed_${ address }`, false )

    }

    // Get other relevant wireguard info from config
    const privatekey = peer_config.match( /PrivateKey ?= ?(.*)/ )?.[ 1 ]?.trim()
    const listenport = peer_config.match( /ListenPort ?= ?(.*)/ )?.[ 1 ]?.trim()
    const dns = peer_config.match( /DNS ?= ?(.*)/ )?.[ 1 ]?.trim()
    const peer_publickey = peer_config.match( /PublicKey ?= ?(.*)/ )?.[ 1 ]?.trim()
    const peer_presharedkey = peer_config.match( /PresharedKey ?= ?(.*)/ )?.[ 1 ]?.trim()
    const peer_allowedips = peer_config.match( /AllowedIPs ?= ?(.*)/ )?.[ 1 ]?.trim()

    // Validate the wireguard config variables for correct format
    let format_errors = []
    if( !privatekey.match( /^[A-Za-z0-9+/=]+$/ ) ) format_errors.push( `PrivateKey is not a valid base64 string` )
    if( !listenport.match( /^\d+$/ ) ) format_errors.push( `ListenPort is not a number` )
    if( !dns.match( /\d*\.\d*\.\d*\.\d*/ ) ) format_errors.push( `DNS is not a valid IP address` )
    if( !peer_publickey.match( /^[A-Za-z0-9+/=]+$/ ) ) format_errors.push( `PublicKey is not a valid base64 string` )
    if( !peer_presharedkey.match( /^[A-Za-z0-9+/=]+$/ ) ) format_errors.push( `PresharedKey is not a valid base64 string` )
    if( !peer_allowedips.match( /\d*\.\d*\.\d*\.\d*/ ) ) format_errors.push( `AllowedIPs is not a valid IP address` )
    if( format_errors.length ) {
        log.warn( `${ log_tag } Wireguard config for peer ${ peer_id } has format errors:`, format_errors )
        await save_miner_status( { miner_uid, status: 'misconfigured' } )
        clear_id_caches()
        return { valid: false, message: `Wireguard config for peer ${ peer_id } has format errors: ${ format_errors.join( ', ' ) }` }
    }
    if( miner_ip && endpoint != miner_ip ) format_errors.push( `Miner supplied endpoint from ip that that does not beling to miner` )

    if( verbose ) log.info( `${ log_tag } Validating wireguard config for peer ${ peer_id }:`, {
        address,
        endpoint,
        privatekey,
        listenport,
        dns,
        peer_publickey,
        peer_presharedkey,
        peer_allowedips,
        interface_id,
        veth_id
    } )

    // If endpoint or address are missing, error
    if( !endpoint ) {
        log.warn( `${ log_tag } Wireguard config for peer ${ peer_id } is missing endpoint` )
        await save_miner_status( { miner_uid, status: 'misconfigured' } )
        clear_id_caches()
        return { valid: false, message: `Wireguard config for peer ${ peer_id } is missing endpoint` }
    }
    if( !address ) {
        log.warn( `${ log_tag } Wireguard config for peer ${ peer_id } is missing address` )
        await save_miner_status( { miner_uid, status: 'misconfigured' } )
        clear_id_caches()
        return { valid: false, message: `Wireguard config for peer ${ peer_id } is missing address` }
    }

    // If endpoint is string, resolve it
    if( !endpoint.match( /\d*\.\d*\.\d*\.\d*/ ) ) {
        const { stdout, stderr } = await run( `dig +short ${ endpoint }`, { silent: true, log_tag } )
        if( stderr ) {
            log.warn( `${ log_tag } Error resolving endpoint ${ endpoint }:`, stderr )
            await save_miner_status( { miner_uid, status: 'misconfigured' } )
            clear_id_caches()
            return { valid: false, message: `Error resolving endpoint ${ endpoint }: ${ stderr }` }
        }
        log.info( `${ log_tag } Resolved endpoint ${ endpoint } to ${ stdout }` )
        endpoint = `${ stdout }`.trim()
    }

    // If address is not an ip address, error
    if( !address.match( /\d*\.\d*\.\d*\.\d*/ ) ) {
        log.warn( `${ log_tag } Wireguard config for peer ${ peer_id } is missing address` )
        await save_miner_status( { miner_uid, status: 'misconfigured' } )
        clear_id_caches()
        return { valid: false, message: `Wireguard config for peer ${ peer_id } is missing address` }
    }

    // If the address is not in CIDR notation, add /32
    if( !address.includes( '/' ) ) {
        if( verbose ) log.info( `${ log_tag } Wireguard config for peer ${ peer_id } address ${ address } is not in CIDR notation, adding /32` )
        address = `${ address }/32`
        peer_config = peer_config.replace( /Address =.*/, `Address = ${ address }` )
    }

    // Path for the WireGuard configuration file.
    const wg_config_path = `/tmp/wg_${ peer_id }.conf`

    // Write the config file and set permissions.
    const write_config_command = `
        # Write the WireGuard config to a temporary file
        printf "%s" "${ peer_config }" > ${ config_path } && \
        chmod 600 ${ config_path } && \
        wg-quick strip ${ config_path } > ${ wg_config_path } && \
        chmod 600 ${ wg_config_path }
        # Log the config files
        tail -n +1 -v ${ config_path } && \
        tail -n +1 -v ${ wg_config_path }
    `

    // Set up network namespace and WireGuard interface.
    const network_setup_command = `

        # Check current ip
        curl -m 5 -s icanhazip.com

        # Add namespace
        ip netns add ${ namespace_id }
        ip netns list

        # Create loopback interface
        ip -n ${ namespace_id } link set lo up

        # Create wireguard interface and move it to namespace
        ip -n ${ namespace_id } link add ${ interface_id } type wireguard
        # ip link set ${ interface_id } netns ${ namespace_id }

        # veth pairing of the isolated interface
        ip link add veth${ veth_id }n type veth peer name veth${ veth_id }h
        ip link set veth${ veth_id }n netns ${ namespace_id }
        # host side veth cofig
        ip addr add ${ veth_subnet_prefix }.1/24 dev veth${ veth_id }h
        ip link set veth${ veth_id }h up
        # namespace side veth config
        ip -n ${ namespace_id } addr add ${ veth_subnet_prefix }.2/24 dev veth${ veth_id }n
        ip -n ${ namespace_id } link set veth${ veth_id }n up
        # enable iptables nat
        sysctl -w net.ipv4.ip_forward=1
        iptables -t nat -A POSTROUTING -s ${ veth_subnet_prefix }.0/24 -o eth0 -j MASQUERADE


        # Before setting things, check properties and routes of the interface
        ip -n ${ namespace_id } addr
        ip -n ${ namespace_id } link show ${ interface_id }
        ip -n ${ namespace_id } route show

        # Apply wireguard config to interface
        ip netns exec ${ namespace_id } wg setconf ${ interface_id } ${ wg_config_path }
        ip netns exec ${ namespace_id } wg showconf ${ interface_id }

        # Pre routing, check what addresses are inside the namespace
        ip -n ${ namespace_id } addr

        # Add routing table
        ip -n ${ namespace_id } a add ${ address } dev ${ interface_id }
        ip -n ${ namespace_id } link set ${ interface_id } up
        ip -n ${ namespace_id } route add default dev ${ interface_id }
        # give wg endpoint exception to default route
        ip -n ${ namespace_id } route add ${ endpoint }/32 via ${ veth_subnet_prefix }.1

        # Add DNS
        mkdir -p /etc/netns/${ namespace_id }/ && echo "nameserver 1.1.1.1" > /etc/netns/${ namespace_id }/resolv.conf

        # Check ip address
        curl -m 5 -s icanhazip.com && ip netns exec ${ namespace_id } curl -m 5 -s icanhazip.com

    `


    // Command to test connectivity via WireGuard.
    const curl_command = `ip netns exec ${ namespace_id } curl -m ${ test_timeout_seconds } -s ${ challenge_url }`

    // Cleanup commands for the namespace and interfaces.
    const cleanup_command = `
        ip link del veth${ veth_id }h || echo "Veth ${ veth_id }h does not exist"
        ip link del veth${ veth_id }n || echo "Veth ${ veth_id }n does not exist"
        ip link del ${ interface_id } || echo "Interface ${ interface_id } does not exist"
        ip netns del ${ namespace_id } || echo "Namespace ${ namespace_id } does not exist"
        iptables -t nat -D POSTROUTING -s ${ veth_subnet_prefix }.0/24 -o eth0 -j MASQUERADE || echo "iptables rule does not exist"
        rm -f ${ config_path } || echo "Config file ${ config_path } does not exist"
        rm -f ${ wg_config_path } || echo "Config file ${ wg_config_path } does not exist"
    `


    // Formulate required functions
    const run_cleanup = async ( { silent=false }={} ) => {

        // loop over cleanup commands
        const cleanup_commands = split_ml_commands( cleanup_command )
        for( const command of cleanup_commands ) {
            await run( command, { silent, log_tag } )
        }

    }
    const run_test = async () => {

        // Check for ip address conflicts
        const timeout = test_timeout_seconds * 5 // How many ip addresses to assume in the worst of circumstances to take their max timeout
        const ip_free = await wait_for_ip_free( { ip_address: address, timeout, log_tag } )
        if( !ip_free ) {
            const ip_cleared = await clean_up_tpn_interfaces( { ip_addresses: [ address ] } )
            if( !ip_cleared ) throw new Error( `IP address ${ address } is still in use after cleanup` )
            log.info( `${ log_tag } IP address ${ address } is free after cleanup` )
        }

        // Mark the ip address as in processing
        cache( `ip_being_processed_${ address }`, true, timeout * 1000 )
        if( verbose ) log.info( `${ log_tag } Marking ip address ${ address } as in processing` )

        // Write the wireguard config to a file
        const config_cmd = await run( write_config_command, { silent: true, log_tag } )
        if( config_cmd.error || config_cmd.stderr ) throw new Error( `Error writing wireguard config: ${ config_cmd.error } ${ config_cmd.stderr }` )

        // loop over network commands
        const network_setup_commands = split_ml_commands( network_setup_command )

        for( const command of network_setup_commands ) {
            await run( command, { silent: !verbose, verbose: false, log_tag } )
        }
    

        // Run the curl command
        const { error, stderr, stdout } = await run( curl_command, { silent: !verbose, verbose, log_tag } )
        if( error || stderr ) {
            if( verbose ) log.warn( `${ log_tag } Error running curl command:`, error, stderr )
            return false
        }
        
        // Isolate the json
        const [ json ] = stdout?.match( /{.*}/s ) || []
        if( !json ) {
            log.warn( `${ log_tag } No JSON response found in stdout:`, stdout )
            return false
        }

        // Return the json response
        if( verbose ) log.info( `${ log_tag } Wireguard config for peer ${ peer_id } responded with:`, json )
        return json

    } 

    // Open the challenge url using the wireguard config
    try {

        // Do pre-emptive cleanup in case a previous run messed up
        if( verbose ) log.info( `\n ${ log_tag } 🧹 Running pre-cleanup commands for peer ${ peer_id }` )
        await run_cleanup( { silent: true, log_tag } )

        // Solve the challenge from the miner ip
        if( verbose ) log.info( `\n ${ log_tag } 🔎 Running test commands for peer ${ peer_id }` )
        const stdout = await run_test()

        // Run cleanup command
        if( verbose ) log.info( `\n ${ log_tag } 🧹  Running cleanup commands for peer ${ peer_id }` )
        await run_cleanup( { silent: !verbose, log_tag } )


        // On failure to get response, error out to catch block
        if( !stdout ) {
            await save_miner_status( { miner_uid, status: 'misconfigured' } )
            throw new Error( `Unable to reach validator through wireguard connection of miner, this suggests misconfiguration` )
        }

        // Extract the challenge and response from the stdout
        let [ json_response ] = stdout?.match( /{.*}/s ) || []
        if( !json_response ) {
            log.warn( `${ log_tag } No JSON response found in stdout:`, stdout )
            return { valid: false, message: `No JSON response found in stdout` }
        }
        const { response } = JSON.parse( json_response )

        // Verify that the response is valid
        log.info( `${ log_tag } Checkin challenge/response solution ${ challenge }/${ response }` )
        const { correct } = await solve_challenge( { challenge, response } )
        
        // Check that the response is valid
        if( !correct ) {
            log.info( `${ log_tag } Wireguard config failed challenge for peer ${ peer_id }` )
            await save_miner_status( { miner_uid, status: 'cheat' } )
            return { valid: false, message: `Wireguard config failed challenge for peer ${ peer_id }` }
        }

        // If the response is valid, return true
        log.info( `${ log_tag } Wireguard config passed for peer ${ peer_id } ${ challenge } with response ${ response }` )
        await save_miner_status( { miner_uid, status: 'online' } )
        return { valid: true, message: `Wireguard config passed for peer ${ peer_id } ${ challenge } with response ${ response }` }

    } catch ( e ) {

        if( verbose ) log.error( `${ log_tag } Error validating wireguard config for peer ${ peer_id }:`, e )
        await save_miner_status( { miner_uid, status: 'offline' } )
        await run_cleanup( { silent: true, log_tag } )
        return { valid: false, message: `Error validating wireguard config for peer ${ peer_id }: ${ e.message }` }

    } finally {

        // Mark ids and ip as free again
        clear_id_caches()

    }

}