import { describe, test, expect } from 'vitest'
import fetch from 'node-fetch' // might be needed
import { wait_for_server_up } from './helpers.js'

describe( 'GET /score', () => {

    test( 'returns JSON', async () => {

        // Wait for the server to start
        await wait_for_server_up()
        
        // Make GET request
        const response = await fetch( 'http://localhost:3000/score' )

        // Check if request was successful
        expect( response.ok ).toBe( true )

        // Ensure content type is JSON
        expect( response.headers.get( 'content-type' ) ).toContain( 'application/json' )

        // Parse body as JSON
        const data = await response.json()

        // Log out the data
        console.log( `Scoring:`, data )

        // Validate you received an object
        expect( data ).toBeInstanceOf( Object )


    } )
} )

describe( 'GET /score/stats', () => {

    test( 'returns JSON', async () => {

        // Wait for the server to start
        await wait_for_server_up()
        
        // Make GET request
        const response = await fetch( 'http://localhost:3000/score/stats' )

        // Check if request was successful
        expect( response.ok ).toBe( true )

        // Ensure content type is JSON
        expect( response.headers.get( 'content-type' ) ).toContain( 'application/json' )

        // Parse body as JSON
        const data = await response.json()

        // Log out the data
        console.log( `Scoring stats:`, data )

        // Validate you received an object
        expect( data ).toBeInstanceOf( Object )

    } )
} )