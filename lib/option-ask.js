// What a required-option refusal names.
//
// "Please choose: Shots" names the heading. A heading is not a choice.
// House Blend and SOE are the choice, and they are already on the sheet.
// When one to four answers are still open, and they are not a yes/no pair,
// the sentence names those answers:
//
//   Please choose: House Blend or SOE
//   请选择 拼配或单一产地
//
// Yes / No stays the question ("Please choose: Heat up?"), because "Yes or
// No" does not say what was asked. More than four stays the question too:
// a paragraph of every topping is not a sentence a thumb can read.
// A sold-out answer is left out — it cannot be chosen. Callers that only
// have the question (checkout) keep saying the question; this is for the
// sheet that has the answers in front of the customer.
//
// The function is plain ES5 on purpose. routes/shop-menu.js pastes
// askWhat.toString() into the QR menu, which runs in the in-app browser.
// The same source is copied into the other sheets. Change it here and
// paste the function again; scripts/test_option_ask.js fails if a copy drifts.

function askWhat(choices, qEn, qCn) {
  function trim(s) {
    return String(s == null ? '' : s).replace(/^\s+|\s+$/g, '');
  }
  function yesNo(labels, cn) {
    var i, s;
    if (!labels.length) return false;
    for (i = 0; i < labels.length; i++) {
      s = labels[i];
      if (cn) { if (s !== '是' && s !== '否') return false; }
      else if (s.toLowerCase() !== 'yes' && s.toLowerCase() !== 'no') return false;
    }
    return true;
  }
  function joinOr(labels, cn) {
    var or, comma;
    if (labels.length <= 1) return labels[0] || '';
    or = cn ? '或' : ' or ';
    if (labels.length === 2) return labels[0] + or + labels[1];
    comma = cn ? '、' : ', ';
    return labels.slice(0, -1).join(comma) + or + labels[labels.length - 1];
  }
  function side(labels, question, cn) {
    if (!labels.length || labels.length > 4 || yesNo(labels, cn)) return question || '';
    return joinOr(labels, cn);
  }
  var en = [], cn = [], i, c, e, z;
  choices = choices || [];
  for (i = 0; i < choices.length; i++) {
    c = choices[i];
    if (!c || c.out) continue;
    e = trim(c.en);
    z = trim(c.cn);
    if (e) en.push(e);
    if (z) cn.push(z);
  }
  return { en: side(en, qEn, false), cn: side(cn, qCn, true) };
}

module.exports = { askWhat };
