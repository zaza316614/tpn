import { log } from "mentie"

const { PUBLIC_URL, PUBLIC_VALIDATOR_URL, PUBLIC_PORT=3000, CI_MODE } = process.env

// Base url based on environment
let base_url = `${ PUBLIC_VALIDATOR_URL || PUBLIC_URL }`.trim()

// If the base url contains a trailing port, remove it
if( base_url.match( /:\d+$/ ) ) {
    log.warn( `Base url ${ base_url } contains a port, this will be ignored` )
    base_url = base_url.replace( /:\d+$/, '' )
}

// If the base url was set to the default (faulty) value in the readme, explode
if( base_url == 'http://1.2.3.4' ) {
    log.error( `You need to set the PUBLIC_VALIDATOR_URL environment variable to your public url, it is currently http://1.2.3.4` )
    // Debounce restarts to docker doesn't have to reboot every  second
    process.exit( 1 )
}

// Remove trailing slash
base_url = `${ base_url }`.replace( /\/$/, '' )

// Check if public url has a port
const has_port = `${ base_url }`.match( /:\d+$/ )

if( has_port && PUBLIC_PORT ) log.error( `You specified a PUBLIC_PORT=${ PUBLIC_PORT } but your base url ${ base_url } also has a port specified, this will break!` )

if( PUBLIC_PORT && !base_url.includes( `:${ PUBLIC_PORT }` ) ) {
    log.info( `Adding port ${ PUBLIC_PORT } to base url` )
    base_url = `${ base_url }:${ PUBLIC_PORT }`
}

export { base_url }