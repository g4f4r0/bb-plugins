(async () => {
  const button = document.querySelector('[data-reserve-shell] button[aria-label="Reload usage"]');
  if (!button || button.disabled) throw new Error('Open Usage and wait for its current reload.');
  window.reserveFixture.fetchedAt = new Date().toISOString();
  const start = performance.now();
  const callsBefore = window.reserveAuditCalls.length;
  const longTasks = [];
  const observer = new PerformanceObserver(list => longTasks.push(...list.getEntries().map(e=>({start:e.startTime,duration:e.duration}))));
  observer.observe({type:'longtask'});
  button.click();
  await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  const shell = document.querySelector('[data-reserve-shell]');
  observer.disconnect();
  return {
    fixtureLogins:window.reserveFixture.totals.length,
    frameMs:performance.now()-start,
    nodes:shell.querySelectorAll('*').length,
    meters:shell.querySelectorAll('[role="meter"]').length,
    virtualRows:shell.querySelectorAll('[data-reserve-row]').length,
    requests:window.reserveAuditCalls.length-callsBefore,
    transitions:[...shell.querySelectorAll('button')].map(e=>getComputedStyle(e).transitionProperty),
    longTasks,
  };
})()
