self.addEventListener('notificationclick', function (event) {
    const notification = event.notification;
    const action = event.action; // 'accept' | 'decline' | '' (body click)
    const data = notification.data || {};

    notification.close();

    if (action === 'decline') {
        event.waitUntil(
            fetch('/api/calls/inbound/decline', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    pstnCallId: data.pstnCallId,
                    doctorId: data.doctorId,
                }),
            })
                .then(function () {
                    // Tell every open tab the call is already handled, so
                    // the in-page ringing UI clears immediately instead of
                    // the doctor clicking Decline there too and hitting a
                    // "Call is not ringing" error (the call is already gone).
                    return clients.matchAll({ type: 'window', includeUncontrolled: true });
                })
                .then(function (clientList) {
                    clientList.forEach(function (client) {
                        client.postMessage({ type: 'INBOUND_CALL_DECLINED', data: data });
                    });
                })
                .catch(function (err) {
                    console.error('Decline from notification failed:', err);
                })
        );
        return;
    }

    // 'accept' (or a click on the notification body) needs the actual
    // browser tab — connecting the call requires the page's live BRTC
    // WebRTC session, which can't run inside a service worker. So we
    // focus/open the tab and hand it off via postMessage.
    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (clientList) {
            for (const client of clientList) {
                if ('focus' in client) {
                    client.postMessage({ type: 'INBOUND_CALL_ACCEPT', data: data });
                    return client.focus();
                }
            }
            if (clients.openWindow) {
                return clients.openWindow('/').then(function (client) {
                    if (client) client.postMessage({ type: 'INBOUND_CALL_ACCEPT', data: data });
                });
            }
        })
    );
});