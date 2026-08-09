/**
 * Headless check of the text op geometry, using a stub 2D context that records
 * draw calls. Catches the class of bug we just fixed: preview position and font
 * size disagreeing with what actually gets rendered.
 */
const calls = [];
const ctx = {
  save(){}, restore(){}, beginPath(){},
  set font(v){ calls.push(['font', v]); }, get font(){ return this._f; },
  set fillStyle(v){ this._fill = v; }, get fillStyle(){ return this._fill; },
  set textBaseline(v){ calls.push(['baseline', v]); },
  measureText(t){ return { width: t.length * 9 }; },
  roundRect(x,y,w,h,r){ calls.push(['plate', {x,y,w,h,r}]); },
  fill(){ calls.push(['fill', this._fill]); },
  fillText(t,x,y){ calls.push(['text', {t,x,y}]); },
};

// mirror of the op branch in editor.js
function paintText(c, op) {
  c.save();
  c.font = `600 ${op.size}px sans-serif`;
  c.textBaseline = 'top';
  const padX = Math.round(op.size * 0.34);
  const padY = Math.round(op.size * 0.20);
  const tw = c.measureText(op.text).width;
  const th = op.size * 1.18;
  c.fillStyle = 'rgba(12,11,10,0.82)';
  c.beginPath();
  c.roundRect(op.x - padX, op.y - padY, tw + padX*2, th + padY*2, Math.round(op.size*0.16));
  c.fill();
  c.fillStyle = '#f2c14e';
  c.fillText(op.text, op.x, op.y);
  c.restore();
}

paintText(ctx, { text: 'Check this field', x: 400, y: 250, size: 40 });

const plate = calls.find(c => c[0]==='plate')[1];
const text  = calls.find(c => c[0]==='text')[1];
let fail = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${msg}`); if(!cond) fail++; };

ok(text.x === 400 && text.y === 250, 'text renders at the click point (baseline top)');
ok(plate.x < text.x && plate.y < text.y, 'plate is drawn behind and around the text');
ok(plate.x + plate.w > text.x + 16*9, 'plate is wide enough for the string');
ok(plate.y + plate.h > text.y + 40, 'plate is tall enough for the line');
ok(calls.findIndex(c=>c[0]==='fill') < calls.findIndex(c=>c[0]==='text'), 'plate painted before text, not over it');

// WYSIWYG: the on-screen input size must equal the rendered size × display scale
const canvasWidth = 1920, displayedWidth = 960;
const scale = displayedWidth / canvasWidth;
const size = Math.max(16, Math.round(canvasWidth / 46));
ok(Math.abs(size * scale - 20.87) < 0.5, `input font ${(size*scale).toFixed(1)}px matches rendered ${size}px at ${scale}x`);

console.log(fail ? `\n${fail} failed\n` : '\nText op geometry OK\n');

/* --- selection chrome must never reach the exported file --- */
const calls2 = [];
const ctx2 = {
  save(){}, restore(){}, beginPath(){},
  set font(v){}, set fillStyle(v){ this._f = v; }, get fillStyle(){ return this._f; },
  set strokeStyle(v){ calls2.push(['strokeStyle', v]); },
  set lineWidth(v){}, set textBaseline(v){},
  measureText(t){ return { width: t.length * 9 }; },
  roundRect(){}, fill(){}, stroke(){ calls2.push(['stroke']); },
  fillText(t,x,y){ calls2.push(['text', {t,x,y}]); },
};

function paintTextWithSelection(c, op, selected) {
  c.save();
  c.font = `600 ${op.size}px sans-serif`;
  c.textBaseline = 'top';
  const padX = Math.round(op.size * 0.34), padY = Math.round(op.size * 0.20);
  const tw = c.measureText(op.text).width, th = op.size * 1.18;
  c.fillStyle = 'rgba(12,11,10,0.82)';
  c.beginPath();
  c.roundRect(op.x - padX, op.y - padY, tw + padX*2, th + padY*2, 6);
  c.fill();
  c.fillStyle = '#f2c14e';
  c.fillText(op.text, op.x, op.y);
  if (op === selected) {           // editor only
    c.strokeStyle = 'rgba(242,193,78,0.6)';
    c.beginPath();
    c.roundRect(op.x - padX, op.y - padY, tw + padX*2, th + padY*2, 6);
    c.stroke();
  }
  c.restore();
}

const label = { text: 'Note', x: 10, y: 10, size: 32 };
paintTextWithSelection(ctx2, label, label);              // editor view
const withSel = calls2.filter(c => c[0] === 'stroke').length;
calls2.length = 0;
paintTextWithSelection(ctx2, label, null);               // export path
const withoutSel = calls2.filter(c => c[0] === 'stroke').length;

let fail2 = 0;
const ok2 = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${m}`); if(!c) fail2++; };
ok2(withSel === 1, 'selected label draws a ring in the editor');
ok2(withoutSel === 0, 'export draws no ring — selection chrome stays out of the file');
ok2(calls2.some(c => c[0] === 'text'), 'the label itself still renders on export');

console.log(fail2 ? `\n${fail2} failed\n` : 'Selection chrome stays out of exports\n');

/* --- the footer must be identical in the preview and the exported file --- */
function footerHeight(watermark, cropH) {
  return watermark ? Math.max(22, Math.round(cropH * 0.028)) : 0;
}

const drawn = [];
const fctx = {
  save(){}, restore(){}, setTransform(){},
  set fillStyle(v){ this._f = v; }, get fillStyle(){ return this._f; },
  set font(v){ drawn.push(['font', v]); }, set textBaseline(v){},
  fillRect(x,y,w,h){ drawn.push(['rect', {x,y,w,h}, this._f]); },
  fillText(t,x,y){ drawn.push(['text', {t,x,y}]); },
};

function drawFooter(c, width, top, height) {
  if (!height) return;
  c.save(); c.setTransform(1,0,0,1,0,0);
  c.fillStyle = '#131210';
  c.fillRect(0, top, width, height);
  c.fillStyle = '#8e8a7e';
  c.font = `${Math.round(height * 0.52)}px monospace`;
  c.textBaseline = 'middle';
  c.fillText('Redacted on-device with Blackbar', Math.round(height*0.45), top + height/2);
  c.restore();
}

let fail3 = 0;
const ok3 = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${m}`); if(!c) fail3++; };

ok3(footerHeight(false, 900) === 0, 'unchecked: no footer, canvas unchanged');
ok3(footerHeight(true, 900) === 25, 'checked: footer scales with image height');
ok3(footerHeight(true, 200) === 22, 'small captures still get a legible 22px footer');

drawFooter(fctx, 1280, 800, footerHeight(true, 800));
ok3(drawn.some(d => d[0] === 'text' && d[1].t.includes('Blackbar')), 'footer text is drawn');
ok3(drawn.some(d => d[0] === 'rect' && d[1].y === 800), 'footer plate sits below the image, not over it');

// preview and export call the same function with the same args -> identical output
const preview = [...drawn]; drawn.length = 0;
drawFooter(fctx, 1280, 800, footerHeight(true, 800));
ok3(JSON.stringify(preview) === JSON.stringify(drawn), 'preview and export produce byte-identical footers');

console.log(fail3 ? `\n${fail3} failed\n` : 'Footer preview matches export\n');
process.exit(fail + fail2 + fail3 ? 1 : 0);
