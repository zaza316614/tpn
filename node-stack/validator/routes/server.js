import express from 'express'
import { log } from 'mentie'
import { ip_from_req } from '../modules/network.js'
export const app = express()

// Add body parser for post requests
app.use( express.json() )

// Handle bad json body formats
app.use( ( err, req, res, next ) => {
    const matches = [ 'body', 'JSON', 'unexpected' ]
    if( err instanceof SyntaxError && err.status === 400 && matches.some( match => err.message.includes( match ) ) ) {
        const { unspoofable_ip } = ip_from_req( req )
        log.info( `Bad JSON body format sent by ${ unspoofable_ip } detected in request url ${ req.url }` )
        return res.status( 400 ).json( { error: 'Invalid JSON body format' } )
    }
    next()
} )