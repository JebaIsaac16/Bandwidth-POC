/*
 * ========================================
 * CALL WIDGET LOADER
 * ========================================
 *
 * For plain static HTML pages with no templating engine.
 *
 * Add ONE line to every page, right before </body>:
 *
 *   <script src="/partials/load-call-widget.js"></script>
 *
 * This fetches /partials/call-widget-partial.html, injects its
 * markup into the current page, then loads the scripts it
 * references (jquery, bandwidth.bundle.js, outbound.code.js,
 * inbound.code.js, code.js) in the correct order.
 *
 * Injecting HTML via innerHTML does NOT execute <script> tags,
 * so this file also loads those scripts separately, in order,
 * after the markup is in the DOM.
 */

(function () {
    const PARTIAL_URL = "/partials/call-widget-partial.html";

    const SCRIPTS = [
        "https://code.jquery.com/jquery-3.7.1.min.js",
        "/dist/bandwidth.bundle.js",
        "/outbound.code.js",
        "/inbound.code.js",
        "/code.js",
    ];

    function loadScript(src) {
        return new Promise(function (resolve, reject) {
            const script = document.createElement("script");
            script.src = src;
            script.onload = resolve;
            script.onerror = function () {
                reject(new Error("Failed to load script: " + src));
            };
            document.body.appendChild(script);
        });
    }

    function loadScriptsInOrder(index) {
        if (index >= SCRIPTS.length) {
            return Promise.resolve();
        }

        return loadScript(SCRIPTS[index]).then(function () {
            return loadScriptsInOrder(index + 1);
        });
    }

    fetch(PARTIAL_URL)
        .then(function (response) {
            if (!response.ok) {
                throw new Error(
                    "Failed to fetch call widget partial: " + response.status,
                );
            }
            return response.text();
        })
        .then(function (html) {
            /*
             * Strip the <script> tags out of the fetched HTML before
             * injecting it — they won't execute via innerHTML anyway,
             * and we load them ourselves below, in order.
             */
            const container = document.createElement("div");
            container.innerHTML = html;

            container.querySelectorAll("script").forEach(function (node) {
                node.remove();
            });

            while (container.firstChild) {
                document.body.appendChild(container.firstChild);
            }

            return loadScriptsInOrder(0);
        })
        .catch(function (error) {
            console.error("Call widget failed to load:", error);
        });
})();
