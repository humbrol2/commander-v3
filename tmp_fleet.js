const ws = new WebSocket('ws://localhost:3000/ws');
ws.onopen = () => { console.log('connected'); };
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.type === 'connected') return;
  console.log('MSG:', msg.type);
  if (msg.bots) {
    for (const b of msg.bots) {
      const id = (b.botId || b.username || '?').padEnd(20);
      const role = (b.role || 'gen').padEnd(16);
      const sys = (b.system || b.currentSystem || '?').padEnd(16);
      const state = (b.state || b.routine || '?').padEnd(16);
      const ship = (b.shipClass || '?').padEnd(14);
      const cr = String(b.credits || '?').padEnd(10);
      const fuel = String(b.fuel ?? '?').padEnd(6);
      const pilot = b.piloting || '?';
      console.log(id + role + sys + state + ship + cr + fuel + 'p:' + pilot);
    }
    console.log('\nTotal:', msg.bots.length);
    ws.close();
    process.exit(0);
  }
};
setTimeout(() => { ws.close(); process.exit(0); }, 5000);
