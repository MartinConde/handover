import { expect, test } from '@playwright/test';

test('long inline edits retain a small bridge acknowledgement cache', async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'Retained heap measurement requires Chromium CDP.');
  await page.goto('/canvas-assets');
  const installed = await page.evaluate(async () => {
    const assets = JSON.parse(document.body.dataset.entries ?? '{}');
    const canvas = await import(`/admin/_assets/${assets.canvas.script}`);
    const identity = {
      protocol: 1,
      requestId: 'memory-test',
      epoch: 'memory-test',
      entry: { collection: 'pages', id: 'home' },
      locale: 'en',
      contentVersion: 0,
    };
    const target = { document: identity.entry, locale: 'en', address: 'body' };
    const frame = { postMessage() {} };
    let version = 0;
    const bridge = canvas.createCanvasParentBridge({
      manifest: { ...identity, mode: 'canvas', status: 'success' },
      frame,
      origin: location.origin,
      listen: false,
      contentVersion: () => version,
      currentTarget: () => target,
      onCommand: () => ({ ok: true, contentVersion: ++version }),
    });
    bridge.receive({
      origin: location.origin,
      source: frame,
      data: { ...identity, type: 'handover:canvas:ready' },
    });
    Object.assign(window, {
      canvasMemoryProbe: {
        async edit() {
          for (let index = 0; index < 500; index += 1) {
            bridge.receive({
              origin: location.origin,
              source: frame,
              data: {
                ...identity,
                contentVersion: version,
                type: 'handover:canvas:command',
                commandId: `command-${index}`,
                target,
                command: { type: 'field', changes: [{ value: `${'a'.repeat(100_000)}${index}` }] },
              },
            });
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();
          }
          return version;
        },
        dispose: () => bridge.dispose(),
      },
    });
    return bridge.connected();
  });
  expect(installed).toBe(true);
  const client = await page.context().newCDPSession(page);
  await client.send('HeapProfiler.collectGarbage');
  const before = await client.send('Runtime.getHeapUsage');
  const accepted = await page.evaluate(() =>
    (
      window as unknown as { canvasMemoryProbe: { edit(): Promise<number> } }
    ).canvasMemoryProbe.edit(),
  );
  expect(accepted).toBe(500);
  await client.send('HeapProfiler.collectGarbage');
  const after = await client.send('Runtime.getHeapUsage');
  await page.evaluate(() =>
    (window as unknown as { canvasMemoryProbe: { dispose(): void } }).canvasMemoryProbe.dispose(),
  );
  expect(after.usedSize - before.usedSize).toBeLessThan(5 * 1024 * 1024);
});
