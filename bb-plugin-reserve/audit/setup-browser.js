(() => {
  // Run only in an isolated audit browser. Original fetch is restored at the end.
  window.reserveAuditFetch ??= window.fetch;
  window.reserveAuditCalls = [];
  const hosts = [{ id: 'fixture', name: 'Fixture machine', status: 'connected' }];
  window.reserveFixture = {
    fetchedAt: new Date().toISOString(), refreshIntervalMs: 60000,
    hosts, unavailableHosts: 0,
    totals: Array.from({ length: 1000 }, (_, i) => ({
      key: `codex|${i}`, providerId: 'codex', providerName: 'Codex',
      accountEmail: `${i}@example.test`, planLabel: 'Plus',
      windows: [{ label: 'Weekly', usedPercent: 20, barPercent: 20,
        resetsAt: '2026-09-19T12:00:00.000Z', cost: null }],
      remainingPercent: 80, resetCredits: null,
      // Include `hosts` here only when benchmarking the pre-audit wire shape.
    })),
  };
  window.fetch = async (...args) => {
    if (String(args[0]).includes('/reserve/rpc/getUsage')) {
      window.reserveAuditCalls.push(performance.now());
      if (window.reserveAuditDelay) await new Promise(resolve => setTimeout(resolve, window.reserveAuditDelay));
      if (window.reserveAuditFailure) throw new Error('Synthetic offline error');
      return new Response(JSON.stringify({ ok: true, result: window.reserveFixture }), { headers: { 'Content-Type': 'application/json' } });
    }
    return window.reserveAuditFetch(...args);
  };
  return 'Synthetic getUsage response installed in this browser only.';
})()
