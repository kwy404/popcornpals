// Checks that a STUN server answers: a throwaway peer connection gathers
// candidates with only that server, and a server reflexive (srflx) candidate
// means the server replied with this device's public address.

export async function probeStun(url, { timeout = 5000, RTCPeerConnection: PC = globalThis.RTCPeerConnection } = {}) {
  if (!PC) return false;
  const pc = new PC({ iceServers: [{ urls: url }] });
  try {
    pc.createDataChannel('probe');
    const found = new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeout);
      pc.onicecandidate = (e) => {
        if (e.candidate && / typ srflx/.test(e.candidate.candidate)) {
          clearTimeout(timer);
          resolve(true);
        } else if (!e.candidate) {
          clearTimeout(timer);
          resolve(false);
        }
      };
    });
    await pc.setLocalDescription(await pc.createOffer());
    return await found;
  } catch {
    return false;
  } finally {
    try {
      pc.close();
    } catch {
      // already closed
    }
  }
}

/** Probe every server at once. Resolves to [{ url, ok }] in the same order. */
export function probeAll(urls, options) {
  return Promise.all(urls.map(async (url) => ({ url, ok: await probeStun(url, options) })));
}
