/**
 * The wire between the Vite build, the server and the console for the
 * console's build id. One home, because the stamp, the server's regex
 * and the page's querySelector would otherwise each carry a copy.
 */

/** The `<meta name>` the build stamps into index.html. */
export const BUILD_META = "bento-build";

/** The response header naming the build the server serves. */
export const BUILD_HEADER = "x-bento-build";

/** A build id is a commit SHA or a hex hash; anything else is refused. */
export const BUILD_ID = /^[\w.-]{1,128}$/;
