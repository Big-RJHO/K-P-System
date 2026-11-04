// The owner has TAG's written permission to collect TAG reports and images for personal research. TAG data
// (reports, scans, cert lists) stays outside this repository; only code lives here.
// Its sha256 is part of tagdb.py's parser_version, so changing this file marks re-parsed records.
// DIG report text -> fields (from tagcert.js; handles both page layouts and centering entries).
function parse(text, cert = "") {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const at = (re, from = 0) => lines.findIndex((l, i) => i >= from && re.test(l));
  const r = { cert };
  const iScore = at(/^TAG SCORE$/);
  if (iScore > 0) {
    const iEn = lines.lastIndexOf('EN', iScore);
    const head = lines.slice(iEn + 1, iScore);
    // Plus reports show the 1000-point score; others show "VIEW SCORE" in its place.
    const last = head[head.length - 1];
    r.score = /^\d+$/.test(last) ? Number(last) : null;
    const desc = /^\d+$/.test(last) || last === 'VIEW SCORE' ? head.slice(0, -1) : head;
    r.card_name = desc[0] || '';
    r.year_line = desc[1] || '';
    r.set_line = desc[2] || '';
    r.variant = desc.slice(3).join(' ');
    r.grade = Number(lines[iScore + 1]);
    r.grade_label = lines[iScore + 2] || '';
  } else {
    const iView = at(/^VIEW SCORE$/);
    if (iView > 0) {
      const iEn = lines.lastIndexOf('EN', iView);
      const desc = lines.slice(iEn + 1, iView);
      r.score = null; r.card_name = desc[0] || ''; r.year_line = desc[1] || ''; r.set_line = desc[2] || ''; r.variant = desc.slice(3).join(' ');
      r.grade = Number(lines[iView + 1]); r.grade_label = lines[iView + 2] || '';
    }
  }
  const comp = (label) => {
    const i = at(new RegExp('^' + label + '$'));
    if (i < 0) return null;
    const pick = (side) => { const j = lines.indexOf(side + ':', i); return j > 0 ? lines[j + 1] : null; };
    return { front: pick('F'), back: pick('B') };
  };
  for (const c of ['CORNERS', 'EDGES', 'CENTERING', 'SURFACE']) r[c.toLowerCase()] = comp(c);
  const dings = (v) => (v == null ? null : Number((v.match(/(\d+)\s*DINGS?/) || [])[1]));
  r.dings = {};
  for (const c of ['corners', 'edges', 'surface']) if (r[c]) r.dings[c] = { front: dings(r[c].front), back: dings(r[c].back) };
  r.centering = r.centering || null;
  // The DINGs list: "Back / TOPRIGHT", "CORNER WEAR" (or "SURFACE / WRINKLE/CREASE"), "VIEW", repeated.
  r.ding_list = [];
  // Pairs of "<Front|Back>[ / location]" and the defect type, until the layout moves on (older reports
  // end the list at "TAG GRADING SUMMARY", newer ones at "DINGS MAP").
  const i0 = at(/^Snapshot Of Defects/);
  if (i0 >= 0) {
    const seg = lines.slice(i0 + 1).filter((l) => l !== 'VIEW');
    for (let k = 0; k < seg.length && /^(front|back)\b/i.test(seg[k]); ) {
      const parts = seg[k].split('/').map((x) => x.trim());
      // A centering entry ("Front", "Centering", "56L/44R 48T/52B") has no location and no VIEW.
      if (parts.length === 1 && /^centering$/i.test(seg[k + 1] || '')) { r.ding_list.push({ side: parts[0].toLowerCase(), location: 'card', type: 'centering ' + (seg[k + 2] || '') }); k += 3; continue; }
      if (k + 1 >= seg.length || /^(front|back)\b/i.test(seg[k + 1])) break;
      r.ding_list.push({ side: (parts[0] || '').toLowerCase(), location: (parts[1] || '').toLowerCase().replace(/\s+/g, ''), type: seg[k + 1].toLowerCase() });
      k += 2;
    }
  }
  const graded = at(/^GRADED /);
  r.graded_on = graded >= 0 ? lines[graded].replace('GRADED ', '') : '';
  return r;
}
module.exports = { parse };
