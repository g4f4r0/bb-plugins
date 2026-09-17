import {formatRemainingPercent, formatResetTime, formatCost} from '../lib/usage.ts';
const start=performance.now();
for(let i=0;i<1000;i++){formatRemainingPercent(i%100);formatResetTime('2026-09-18T12:00:00Z');formatCost({usedUsdCents:i,limitUsdCents:1000});}
console.log(JSON.stringify({rows:1000,formatMs:performance.now()-start}));
