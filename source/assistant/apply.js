// Moodle answer application. Input: [{number: "1", values: ["answer", ...]}, ...].
globalThis.OEBAssistant ||= {};
globalThis.OEBAssistant.applyAnswers = async function applyAnswers(answers) {
  const clean = value => (value || '').replace(/\s+/g, ' ').trim();
  const findOption = (options, value) => options.find(option => clean(option.textContent) === clean(value));
  const comparable = value => clean(value).toLocaleLowerCase().replace(/^[a-z][.)]\s*/i, '');
  const change = el => {
    el.dispatchEvent(new Event('input', {bubbles: true}));
    el.dispatchEvent(new Event('change', {bubbles: true}));
  };
  const write = (el, value) => { el.value = String(value); change(el); };
  const setSelect = (select, answer) => {
    if (!select) throw new Error('Missing select control.');
    const option = findOption([...select.options].filter(o => o.value !== '' && !/^choose\.{0,3}$/i.test(clean(o.textContent))), answer);
    if (!option) throw new Error(`Option not found: ${answer}`);
    write(select, option.value);
  };
  const text = node => clean(node?.textContent);
  const choiceLabel = (q, input) => {
    const labelledBy = input.getAttribute('aria-labelledby');
    const label = (labelledBy && document.getElementById(labelledBy)) ||
      (input.id && q.querySelector(`[id="${CSS.escape(input.id)}_label"]`)) ||
      (input.id && [...q.querySelectorAll('label[for]')].find(el => el.htmlFor === input.id));
    if (!label) return '';
    const clone = label.cloneNode(true);
    clone.querySelectorAll('.answernumber, .accesshide, .visually-hidden').forEach(el => el.remove());
    return text(clone).replace(/^[a-z]\.[\s\u00a0]*/i, '');
  };
  const setRichText = (textarea, value) => {
    const safe = String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const html = `<p>${safe.replace(/\r?\n/g, '<br>')}</p>`;
    // Content scripts cannot normally access the page's TinyMCE JavaScript object. Moodle still
    // submits this textarea, so update it directly and mirror the result into TinyMCE's iframe.
    textarea.value = html;
    const iframe = document.getElementById(`${textarea.id}_ifr`) ||
      textarea.closest('.editor_atto, .editor_tiny, .felement')?.querySelector('iframe');
    const body = iframe?.contentDocument?.body;
    if (body) {
      body.innerHTML = html;
      body.dispatchEvent(new Event('input', {bubbles: true}));
      body.dispatchEvent(new Event('change', {bubbles: true}));
    }
    change(textarea);
  };
  const setMarkerAnswers = (q, values) => {
    const fields = [...q.querySelectorAll('.ddform input.choices')];
    const background = q.querySelector('.droparea img.dropbackground');
    if (!fields.length || !background) throw new Error('Marker response controls are missing.');
    if (values.length !== fields.length) throw new Error('Marker count differs.');
    const width = background.naturalWidth || background.width;
    const height = background.naturalHeight || background.height;
    const parsed = values.map((value, index) => {
      const points = String(value).split(';').map(part => {
        const match = part.trim().match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
        if (!match) throw new Error(`Marker ${index + 1} must use x,y coordinates.`);
        const x = Math.round(Number(match[1]));
        const y = Math.round(Number(match[2]));
        if (x < 0 || y < 0 || (width && x >= width) || (height && y >= height)) {
          throw new Error(`Marker ${index + 1} is outside the ${width}×${height} image.`);
        }
        return {x, y};
      });
      const max = Number([...fields[index].classList].find(name => /^noofdrags\d+$/.test(name))?.replace('noofdrags', '')) || 1;
      if (points.length > max) throw new Error(`Marker ${index + 1} has too many placements.`);
      return points;
    });

    q.querySelectorAll('.oeb-ai-marker').forEach(marker => marker.remove());
    const droparea = q.querySelector('.droparea');
    parsed.forEach((points, index) => {
      write(fields[index], points.map(point => `${point.x},${point.y}`).join(';'));
      const choice = [...fields[index].classList].find(name => /^choice\d+$/.test(name));
      const source = choice && q.querySelector(`.draghomes .marker.${choice}.dragplaceholder, .dd-original .marker.${choice}`);
      points.forEach(point => {
        const marker = document.createElement('span');
        marker.className = 'marker oeb-ai-marker';
        marker.title = `AI placement: ${text(source) || `Marker ${index + 1}`}`;
        marker.setAttribute('aria-label', marker.title);
        marker.style.cssText = `position:absolute;left:${point.x / (width || 1) * 100}%;top:${point.y / (height || 1) * 100}%;z-index:5;pointer-events:none;`;
        const icon = source?.querySelector('img')?.cloneNode(true);
        if (icon) marker.append(icon);
        else marker.textContent = '⊕';
        droparea.append(marker);
      });
    });
  };
  const results = [];
  const nodes = [...document.querySelectorAll('.que')];
  for (const entry of answers) {
    const q = nodes.find((node, i) => text(node.querySelector('.info .qno')) === String(entry.number) ||
      (!node.querySelector('.info .qno') && String(i + 1) === String(entry.number)));
    if (!q) { results.push({number: entry.number, status: 'skipped', reason: 'Question not on page.'}); continue; }
    const values = entry.values;
    try {
      if (!Array.isArray(values) || !values.length) throw new Error('No answer supplied.');
      if (q.matches('.multichoice, .truefalse') || q.querySelector('.answer input[type="radio"], .answer input[type="checkbox"]')) {
        const controls = [...q.querySelectorAll('.answer input[type="radio"], .answer input[type="checkbox"]')]
          .filter(input => input.value !== '-1');
        const pairs = controls.map(input => {
          return {input, label: choiceLabel(q, input)};
        });
        if (controls[0]?.type === 'radio' && values.length !== 1) throw new Error('Expected one option.');
        const selected = values.map(value => {
          const wanted = comparable(value);
          const byText = pairs.find(pair => comparable(pair.label) === wanted);
          if (byText) return byText.input;
          const letter = String(value).trim().match(/^([a-z])[.)]?$/i)?.[1]?.toLowerCase();
          return letter ? pairs[letter.charCodeAt(0) - 97]?.input : undefined;
        });
        if (selected.some(input => !input)) throw new Error('An option did not match the page.');
        if (controls[0]?.type === 'checkbox') {
          for (const {input} of pairs) if (input.checked !== selected.includes(input)) input.click();
        } else {
          selected[0].click();
          if (!selected[0].checked) {
            selected[0].checked = true;
            change(selected[0]);
          }
        }
      } else if (q.classList.contains('ordering')) {
        const list = q.querySelector('.sortablelist');
        const items = [...(list?.querySelectorAll('.sortableitem') || [])];
        if (!list || values.length !== items.length) throw new Error('Ordering list length differs.');
        const remaining = [...items];
        const ordered = values.map(value => {
          const index = remaining.findIndex(item => text(item.querySelector('[data-itemcontent]')) === clean(value));
          if (index < 0) throw new Error(`Ordering item not found: ${value}`);
          return remaining.splice(index, 1)[0];
        });
        const hidden = q.querySelector('input[type="hidden"][name*="_response_"]');
        if (!hidden) throw new Error('Ordering response field missing.');
        ordered.forEach(item => list.append(item));
        write(hidden, ordered.map(item => item.id).join(','));
      } else if (q.matches('.match, .randomsamatch') || q.querySelector('.answer tr .text + .control select')) {
        const selects = [...q.querySelectorAll('.answer tr .control select')];
        if (values.length !== selects.length) throw new Error('Matching row count differs.');
        selects.forEach((select, i) => setSelect(select, values[i]));
      } else if (q.classList.contains('gapselect')) {
        const selects = [...q.querySelectorAll('.qtext .control select')];
        if (values.length !== selects.length) throw new Error('Blank count differs.');
        selects.forEach((select, i) => setSelect(select, values[i]));
      } else if (q.classList.contains('multianswer')) {
        const blanks = [...q.querySelectorAll('.formulation .subquestion')];
        if (values.length !== blanks.length) throw new Error('Blank count differs.');
        blanks.forEach((blank, i) => {
          const select = blank.querySelector('select');
          if (select) setSelect(select, values[i]);
          else {
            const input = blank.querySelector('input[type="text"], textarea');
            if (!input) throw new Error(`Blank ${i + 1} is unsupported.`);
            write(input, values[i]);
          }
        });
      } else if (q.classList.contains('ddmarker') || q.querySelector('.ddarea img.dropbackground, .ddform input.choices')) {
        setMarkerAnswers(q, values);
      } else if (q.classList.contains('ddwtos')) {
        const drops = [...q.querySelectorAll('.qtext .drop')];
        if (values.length !== drops.length) throw new Error('Blank count differs.');
        for (let i = 0; i < drops.length; i++) {
          const drop = drops[i];
          const place = [...drop.classList].find(c => /^place\d+$/.test(c));
          const group = [...drop.classList].find(c => /^group\d+$/.test(c));
          const field = [...q.querySelectorAll('input.placeinput')].find(el => el.classList.contains(place));
          const drag = [...q.querySelectorAll('.answercontainer .draghome:not(.dragplaceholder)')]
            .find(el => el.classList.contains(group) && text(el) === clean(values[i]));
          const choice = drag && [...drag.classList].find(c => /^choice\d+$/.test(c));
          if (!field || !choice) throw new Error(`Drag option not found for blank ${i + 1}.`);
          const desired = choice.slice(6);
          // Use Moodle's keyboard handler, which updates both its visual item and response field.
          for (let tries = 0; field.value !== desired && tries < 30; tries++) {
            const event = new KeyboardEvent('keydown', {key: 'ArrowDown', code: 'ArrowDown', keyCode: 40, which: 40, bubbles: true, cancelable: true});
            drop.dispatchEvent(event);
            await new Promise(resolve => setTimeout(resolve, 350));
          }
          if (field.value !== desired) throw new Error(`Could not place drag answer in blank ${i + 1}.`);
        }
      } else {
        const inputs = [...q.querySelectorAll('.formulation input[type="text"], .formulation textarea')];
        const selects = [...q.querySelectorAll('.formulation select')];
        if (inputs.length) {
          if (values.length !== inputs.length) throw new Error('Input count differs.');
          inputs.forEach((input, i) => {
            if (input.tagName === 'TEXTAREA' && input.dataset.fieldtype === 'editor') {
              setRichText(input, values[i]);
            } else write(input, values[i]);
          });
        } else if (selects.length) {
          if (values.length !== selects.length) throw new Error('Select count differs.');
          selects.forEach((select, i) => setSelect(select, values[i]));
        } else throw new Error('This question type is unsupported.');
      }
      results.push({number: entry.number, status: 'filled'});
    } catch (error) {
      results.push({number: entry.number, status: 'skipped', reason: error.message});
    }
  }
  return results;
};
