// Set up environment
import 'dotenv/config'
import { log } from 'mentie'
import { readFile } from 'fs/promises'
import { get_git_branch_and_hash } from './modules/metagraph.js'
const { version } = JSON.parse( await readFile( new URL( './package.json', import.meta.url ) ) )
const { branch, hash } = await get_git_branch_and_hash()
const last_start = new Date().toISOString()
log.info( `${ last_start } - Starting TPN miner component version ${ version } (${ branch }/${ hash })` )

// Initialise database
import { close_pool, init_tables } from './modules/database.js'
log.info( 'Initialising database tables' )
await init_tables()
log.info( 'Database tables initialised' )

// Import express
import { app } from './routes/server.js'
log.info( `Setting up routes` )

// Identify self on /
app.get( '/', ( req, res ) => {
    return res.json( {
        notice: `I am a TPN Network miner component running v${ version }`,
        info: 'https://tpn.taofu.xyz/',
        version,
        last_start,
        branch,
        hash
    } )
} )

// Import challenge/response router
import { router as challenge_response_router } from './routes/challenge-response.js'
app.use( '/challenge', challenge_response_router )

// Import wireguard router
import { router as wireguard_router } from './routes/wireguard.js'
app.use( '/wireguard', wireguard_router )

// Import and add protocol routes
import { router as protocol_router } from './routes/protocol.js'
app.use( '/protocol', protocol_router )

// Start the server
const { PORT=3001 } = process.env
const server = app.listen( PORT, () => log.info( `Server started on port ${ PORT }` ) )

const handle_close = async reason => {
    log.info( 'Closing server, reason: ', reason || 'unknown' )
    log.info( 'Shutting down gracefully...' )
    server.close()
    await close_pool()
    process.exit( 0 )
}

// Handle shutdown signals
const shutdown_signals = [ 'SIGTERM', 'SIGINT', 'SIGQUIT' ]
shutdown_signals.map( signal => {
    log.info( `Listening for ${ signal } signal to shut down gracefully...` )
    process.on( signal, async () => handle_close( signal ) )
} )

// Handle uncaught exceptions
process.on( 'uncaughtException', async ( err ) => {
    const now = new Date().toISOString()
    log.error( `${ now } - Uncaught exception:`, err.message, err.stack )
    await handle_close( 'uncaughtException' )
} )
process.on( 'unhandledRejection', async ( reason, promise ) => {
    const now = new Date().toISOString()
    log.error( `${ now } - Unhandled rejection at:`, promise, 'reason:', reason )
    await handle_close( 'unhandledRejection' )
} )