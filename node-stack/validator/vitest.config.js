import { defineConfig } from 'vitest/config'

export default defineConfig( {
    test: {
    // Your other Vitest test configurations
        forceRerunTriggers: [ '**/*.js' ], // Specify the files to trigger reruns
    },
} )
