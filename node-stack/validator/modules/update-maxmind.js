import { log } from "mentie"

// Check for license key
const { MAXMIND_LICENSE_KEY } = process.env
if( !MAXMIND_LICENSE_KEY ) {
    log.error( 'MAXMIND_LICENSE_KEY is required' )
}

import { spawn } from 'child_process'

// Spawn a child process that runs "npm run-script updatedb license_key=YOUR_LICENSE_KEY"
// in the "node_modules/geoip-lite" directory.
import url from 'url'
import { get_timestamp, set_timestamp } from "./database.js"
const __dirname = url.fileURLToPath( new URL( '.', import.meta.url ) )


/**
 * Initiates the Maxmind update process by spawning a child process that runs the "updatedb" npm script.
 *
 * The function spawns a process in the geoip-lite directory (relative to the current file) and uses a shell
 * to execute the command. It passes the MAXMIND_LICENSE_KEY as an argument to the script and logs the process's
 * stdout data to monitor progress.
 *
 * @returns {ChildProcess} The spawned child process handling the update.
 */
function start_maxmind_update( { on_err, on_close }={} ) {

    const updateProcess = spawn( 'npm', [ 'run-script', 'updatedb', `license_key=${ MAXMIND_LICENSE_KEY }` ], {
        cwd: `${ __dirname }/../node_modules/geoip-lite`, // run in the geoip-lite directory
        shell: true // use shell for command
    } )
        
    // Listen for output from stdout
    updateProcess.stdout.on( 'data', ( data ) => {
        log.info( `Maxmind update progress:`, data.toString() )
    } )

    // Listen for errors on stderr
    if( on_err ) updateProcess.stderr.on( 'data', on_err )
        
    // Fires when the process exits
    if( on_close ) updateProcess.on( 'close', on_close )

    return updateProcess

}

/**
 * Updates the MaxMind GeoIP database by running the `updatedb` npm script.
 * @returns {Promise<string>} A promise that resolves with a success message when the update is complete, or rejects with an error message if the update fails.
 */
export async function update_maxmind() {

    // Load geoip-lite
    const { default: geoip } = await import( 'geoip-lite' )

    // Check if there is a functioning maxmind database
    let maxmind_db_ok = false
    try {
        geoip.lookup( '1.1.1.1' )
        maxmind_db_ok = true
    } catch ( e ) {
        log.info( `Maxmind database is not functioning yet: `, e )
    }

    // Check if we should update based on timestamp
    const update_min_interval_ms = 1000 * 60 * 60 * .5 // 30 minutes
    const last_update = await get_timestamp( { label: 'last_maxmind_update' } )
    const now = Date.now()
    const time_since_last_update = now - last_update
    if( time_since_last_update < update_min_interval_ms ) {
        log.info( `Maxmind database update age is below minimum interval of ${ update_min_interval_ms / 1000 / 60 } minutes` )
        return 'Maxmind database is up to date'
    }
    log.info( `Database age is ${ ( now - last_update ) / 1000 / 60 } minutes` )

    // If maxmind is ok, update in the background
    if( maxmind_db_ok ) {
        log.info( `Maxmind database is functioning, updating in the background` )
        start_maxmind_update( {
            on_err: ( data ) => {
                log.error( `Maxmind update error:`, data.toString() )
            },
            on_close: ( code ) => {
                log.info( `Maxmind update complete:`, code )
                log.info( `Reloading Maxmind database into memory` )
                geoip.reloadDataSync()
                log.info( `Maxmind database reloaded into memory` )
                set_timestamp( { label: 'last_maxmind_update', timestamp: Date.now() } ).then( () => {
                    log.info( `Maxmind database update timestamp set` )
                } )
            }
        } )
    }

    // If maxmind is not ok, we need to wait for the update to complete
    if( !maxmind_db_ok ) return new Promise( ( resolve, reject ) => {

        log.info( `Maxmind database is not yet functioning, updating in a blocking way now` )

        start_maxmind_update( {

            on_err: ( data ) => {
                log.error( `Maxmind update error:`, data.toString() )
                reject( data.toString() )
            },
            on_close: ( code ) => {
                log.info( `Maxmind update complete:`, code )

                // Reload database
                log.info( `Reloading Maxmind database into memory` )
                geoip.reloadDataSync()
                log.info( `Maxmind database reloaded into memory` )
                set_timestamp( { label: 'last_maxmind_update', timestamp: Date.now() } ).then( () => {
                    log.info( `Maxmind database update timestamp set` )
                    resolve( `Maxmind database update complete` )
                } )
            }
        } )

    } )

}