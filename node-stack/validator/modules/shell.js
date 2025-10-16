import { exec } from 'child_process'
import { log } from 'mentie'


/**
 * Executes a shell command asynchronously and logs the output based on the provided options.
 *
 * @param {string} command - The shell command to execute.
 * @param {Object} [options={}] - Options to control the execution and logging behavior.
 * @param {boolean} [options.silent=false] - If true, suppresses all logging.
 * @param {boolean} [options.verbose=false] - If true, logs detailed output including errors, stdout, and stderr.
 * @param {string} [options.log_tag=`[ ${Date.now()} ] `] - A custom log tag to prefix log messages.
 * @returns {Promise<Object>} A promise that resolves with an object containing:
 *   - `error` (Error|null): The error object if the command fails, or null if no error occurred.
 *   - `stdout` (string|null): The standard output of the command, or null if empty.
 *   - `stderr` (string|null): The standard error output of the command, or null if empty.
 */
export async function run( command, { silent=false, verbose=false, log_tag=`[ ${ Date.now() } ] ` }={} ) {

    return new Promise( ( resolve ) => {


        if( !silent && !verbose ) log.info( log_tag, `exec:`, command )
        exec( command, ( error, stdout, stderr ) => {

            if( !stderr?.length ) stderr = null
            if( !stdout?.length ) stdout = null

            // If silent, just resolve with data
            if( silent ) return resolve( { error, stdout, stderr } )
            
            // If verbose, log all
            if( verbose ) log.info( log_tag, { command, error, stdout, stderr } )

            // Log the output
            if( !verbose && stdout ) log.info( log_tag, `stdout:`, stdout.trim?.() || stdout )
            if( !verbose && stderr ) log.warn( log_tag, `stderr:`, stderr.trim?.() || stderr )
            if( !verbose && error && !stderr ) log.info( log_tag, `Error running ${ command }:`, error )


            // Resolve with data
            resolve( { error, stdout, stderr } )

        } )

    } )

}

/**
 * Checks the system for warnings related to available resources
 */
export async function check_system_warnings() {

    try {

        // Check system ram amount
        const min_ram_gib = 8
        const ram_check = await run( `free -g | grep Mem | awk '{print $2}'` )
        const ram_gib = ram_check.stdout && parseInt( ram_check.stdout.trim() )
        if( ram_gib < min_ram_gib ) log.warn( `Your system has only ${ ram_gib } GiB of RAM, which is below the recommended ${ min_ram_gib } GiB. This may cause performance issues.` )    

        // Check if the system has a swap
        const swap_check = await run( `cat /proc/swaps | wc -l` )
        const has_swap = swap_check.stdout && parseInt( swap_check.stdout.trim() ) > 1
        if( !has_swap ) log.warn( `Your system doesn't appear to have a swapfile configured, you should probably set that up to prevent crashes under load` )

        // Check if the system has enough disk space
        const min_disk_space_gib = 10
        const disk_check = await run( `df -BG / | tail -1 | awk '{print $4}'` )
        const disk_space_gib = disk_check.stdout && parseInt( disk_check.stdout.trim().replace( 'G', '' ) )
        if( disk_space_gib < min_disk_space_gib ) log.warn( `Your system has only ${ disk_space_gib } GiB of free disk space, which is below the recommended ${ min_disk_space_gib } GiB. This may cause performance issues.` )

        // Check if the host user is root
        const is_root = process.getuid && process.getuid() === 0
        if( is_root ) log.warn( `You are running this validator as root, which is not recommended. Please run it as a non-root user to avoid potential security issues.` )
        
        // Check if recommended environment variables are set
        const recommended_env_vars = [ 
            `LOG_LEVEL`,
            `MAXMIND_LICENSE_KEY`,
            `IP2LOCATION_DOWNLOAD_TOKEN`,
            `PUBLIC_VALIDATOR_URL`,
            `PUBLIC_PORT`,
        ]
        const missing_keys = recommended_env_vars.filter( key => !process.env[ key ] )
        if( missing_keys.length ) log.warn( `The following recommended environment variables are not set: ${ missing_keys.join( ', ' ) }. This may cause issues with the validator. See README.md for instructions` )
        
    } catch ( e ) {
        log.error( `Error checking system warnings:`, e )
    }

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