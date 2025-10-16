import { wait } from "mentie"

// Import the fetch function
import fetch from 'node-fetch'

/**
 * Waits for the server to be up by continuously fetching the server status.
 * The function will keep trying until it receives a successful response.
 *
 * @async
 * @function wait_for_server_up
 * @returns {Promise<void>} Resolves when the server is up.
 */
export async function wait_for_server_up() {

    // While loop that fetches server status
    let server_up = false
    let count = 0
    const max_count = 60
    while( !server_up ) {

        // If max count exceeded, throw
        if( count > max_count ) throw new Error( `Server did not start after ${ max_count } attempts` )

        // Fetch the server status
        const response = await fetch( 'http://localhost:3000' ).catch( e => e )

        // Check if the server is up
        server_up = response.ok

        // Wait for a second before trying again
        await wait( 1000 )

        // Increment the count
        count++

    }

}