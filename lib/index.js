/**
 * dsh-ios-pwa-fix — Host half.
 *
 * This package is a browser-side layout patch. This module gives the package a
 * loadable Host entry so the profile can insert its loader row. It starts no
 * service and reads no data.
 */
export const name = 'dsh-ios-pwa-fix'

/** No Host service is required. */
export const inject = []

/** No Host work. */
export function apply() {}
