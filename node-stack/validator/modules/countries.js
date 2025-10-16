import { sanetise_string } from "mentie"
import { get_tpn_cache } from "./caching.js"

/**
 * Translate a country code to a country name based on protocol cache
 * @param {string} code - The country code to translate.
 * @returns {string|undefined} - The country name associated with the code.
 */
export const code_to_country = code => {

    const country_code_to_name = get_tpn_cache( 'miner_country_code_to_name', {} )

    // Try to get the name from the code
    let country_name = country_code_to_name[ code ]

    // Attempt sanetised (lowercase) code
    if( !country_name ) country_name = country_code_to_name[ sanetise_string( code ) ]

    
    return country_name

}

/**
 * Translate a country name to a country code based on protocol cache
 * @param {string} name - The country name to translate.
 * @returns {string|undefined} - The country code associated with the name.
 */
export const country_to_code = name => {

    const country_name_to_code = get_tpn_cache( 'miner_country_name_to_code', {} )

    // Try to get the code from the name
    let country_code = country_name_to_code[ name ]

    // Attempt sanetised (lowercase) name
    if( !country_code ) country_code = country_name_to_code[ sanetise_string( name ) ]

    return country_code

}