// Moodle question extraction. Kept separate from application and provider code.
globalThis.OEBAssistant ||= {};
globalThis.OEBAssistant.extractQuestions = async function extractQuestions() {
  const MAX_IMAGES = 8;
  const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
  const MAX_TOTAL_IMAGE_BYTES = 16 * 1024 * 1024;
  let capturedImages = 0;
  let capturedBytes = 0;

  const clean = value => (value || '').replace(/\s+/g, ' ').trim();
  const text = node => clean(node?.textContent);
  const prompt = (source, controls = '') => {
    if (!source) return '';
    const clone = source.cloneNode(true);
    clone.querySelectorAll('.accesshide, .visually-hidden, input[type="hidden"], script, style').forEach(el => el.remove());
    if (controls) clone.querySelectorAll(controls).forEach((el, i) => {
      el.replaceWith(document.createTextNode(`[answer ${i + 1}]`));
    });
    clone.querySelectorAll('br').forEach(el => el.replaceWith(document.createTextNode(' ')));
    clone.querySelectorAll('p, div, li, h1, h2, h3, h4, h5, h6').forEach(el => {
      el.prepend(document.createTextNode(' '));
      el.append(document.createTextNode(' '));
    });
    return text(clone);
  };
  const selectOptions = select => [...(select?.options || [])]
    .filter(option => option.value !== '' && text(option) && !/^choose\.{0,3}$/i.test(text(option)))
    .map(text);
  const choiceGroup = el => [...el.classList].find(c => /^group\d+$/.test(c));
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
  const toDataUrl = blob => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('Could not read image data.'));
    reader.readAsDataURL(blob);
  });
  const captureImage = async (img, id) => {
    if (!img || capturedImages >= MAX_IMAGES) return null;
    const src = img.currentSrc || img.src;
    if (!src || /theme\/image\.php.*(?:icon|crosshair)/i.test(src)) return null;
    try {
      const response = await fetch(src, {credentials: 'include'});
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const blob = await response.blob();
      const bytes = blob.size;
      if (!blob.type.startsWith('image/')) throw new Error('Resource is not an image.');
      if (bytes > MAX_IMAGE_BYTES) throw new Error('Image is larger than 4 MB.');
      const dataUrl = await toDataUrl(blob);
      if (bytes > MAX_IMAGE_BYTES || capturedBytes + bytes > MAX_TOTAL_IMAGE_BYTES) return null;
      capturedImages += 1;
      capturedBytes += bytes;
      return {
        id,
        alt: clean(img.alt) || 'Question image',
        src,
        width: img.naturalWidth || img.width || 0,
        height: img.naturalHeight || img.height || 0,
        dataUrl
      };
    } catch (error) {
      return {id, alt: clean(img.alt) || 'Question image', src, unavailable: error.message};
    }
  };
  const captureQuestionImages = async (q, number) => {
    const candidates = [...q.querySelectorAll('.formulation img.dropbackground, .formulation .qtext img, .formulation img')]
      .filter((img, index, all) => all.indexOf(img) === index)
      .filter(img => !img.classList.contains('icon') && img.getAttribute('aria-hidden') !== 'true');
    const images = [];
    for (let i = 0; i < candidates.length; i++) {
      const image = await captureImage(candidates[i], `question-${number}-image-${i + 1}`);
      if (image) images.push(image);
    }
    return images;
  };

  const questions = [];
  const questionNodes = [...document.querySelectorAll('.que')];
  for (let index = 0; index < questionNodes.length; index++) {
    const q = questionNodes[index];
    let type = ['multichoice', 'shortanswer', 'truefalse', 'essay', 'numerical', 'calculatedsimple', 'calculated', 'ordering', 'gapselect', 'ddwtos', 'ddmarker', 'multianswer', 'randomsamatch', 'match']
      .find(name => q.classList.contains(name)) || 'unknown';
    if (type === 'unknown' && q.querySelector('.ddarea img.dropbackground, .ddform input.choices')) type = 'ddmarker';
    if (type === 'unknown' && q.querySelector('.answer tr .text + .control select')) type = 'match';
    // Moodle calls calculated multiple choice questions "calculatedmulti". Their controls and
    // expected answer format are the same as ordinary multiple choice questions.
    if (type === 'unknown' && q.querySelector('.answer input[type="radio"], .answer input[type="checkbox"]')) type = 'multichoice';
    if (type === 'unknown' && q.querySelector('.formulation input[type="text"]')) type = 'shortanswer';
    const item = {number: text(q.querySelector('.info .qno')) || String(index + 1), type};
    const qtext = q.querySelector('.formulation .qtext');
    const formulation = q.querySelector('.formulation');
    if (type === 'match' || type === 'randomsamatch') {
      item.question = prompt(qtext);
      item.blanks = [...q.querySelectorAll('.answer tr')].map(row => ({
        prompt: prompt(row.querySelector('.text')),
        type: 'select',
        options: selectOptions(row.querySelector('.control select'))
      }));
      const common = item.blanks[0]?.options;
      if (common && item.blanks.every(blank => JSON.stringify(blank.options) === JSON.stringify(common))) {
        item.options = common;
        item.blanks.forEach(blank => delete blank.options);
      }
    } else if (type === 'ordering') {
      const clone = qtext?.cloneNode(true);
      clone?.querySelectorAll('.ablock, .answer').forEach(el => el.remove());
      item.question = prompt(clone);
      item.items = [...q.querySelectorAll('.sortableitem [data-itemcontent]')].map(text);
    } else if (type === 'gapselect') {
      item.question = prompt(qtext, '.control');
      item.blanks = [...q.querySelectorAll('.qtext .control select')].map(select => ({
        type: 'select', options: selectOptions(select)
      }));
    } else if (type === 'ddwtos') {
      item.question = prompt(qtext, '.drop');
      const groups = {};
      q.querySelectorAll('.answercontainer .draghome:not(.dragplaceholder)').forEach(choice => {
        const group = choiceGroup(choice);
        if (!group) return;
        groups[group] ||= [];
        if (text(choice) && !groups[group].includes(text(choice))) groups[group].push(text(choice));
      });
      item.blanks = [...q.querySelectorAll('.qtext .drop')].map(drop => ({
        type: 'drag', options: groups[choiceGroup(drop)] || []
      }));
    } else if (type === 'ddmarker') {
      item.question = prompt(qtext);
      const fields = [...q.querySelectorAll('.ddform input.choices')];
      item.markers = fields.map((field, markerIndex) => {
        const choice = [...field.classList].find(name => /^choice\d+$/.test(name));
        const marker = choice && q.querySelector(`.draghomes .marker.${choice}.dragplaceholder, .dd-original .marker.${choice}`);
        const dragCount = [...field.classList].find(name => /^noofdrags\d+$/.test(name));
        return {
          label: text(marker) || `Marker ${markerIndex + 1}`,
          choice: choice || `choice${markerIndex + 1}`,
          placements: Number(dragCount?.replace('noofdrags', '')) || 1
        };
      });
    } else if (type === 'multianswer') {
      item.question = prompt(formulation, '.subquestion');
      item.blanks = [...q.querySelectorAll('.formulation .subquestion')].map(sub => {
        const select = sub.querySelector('select');
        return select ? {type: 'select', options: selectOptions(select)} : {type: 'text'};
      });
    } else {
      if (qtext) item.question = prompt(qtext, 'input[type="text"], textarea, select');
      else {
        const clone = formulation?.cloneNode(true);
        clone?.querySelectorAll('.answer, .ablock').forEach(el => el.remove());
        item.question = prompt(clone, 'input[type="text"], textarea, select');
      }
      const choices = [...q.querySelectorAll('.answer input[type="radio"], .answer input[type="checkbox"]')]
        .filter(input => input.value !== '-1').map(input => choiceLabel(q, input));
      if (choices.length) item.options = choices;
      const fields = q.querySelectorAll('.formulation input[type="text"], .formulation textarea');
      if (fields.length > 1) item.blanks = [...fields].map(() => ({type: 'text'}));
      const selects = [...q.querySelectorAll('.formulation select')];
      if (selects.length) item.blanks = selects.map(select => ({type: 'select', options: selectOptions(select)}));
    }

    const images = await captureQuestionImages(q, item.number);
    if (images.length) {
      item.images = images;
      const background = q.querySelector('.dropbackground');
      if (background) item.backgroundImage = images.find(image => image.src === (background.currentSrc || background.src))?.id;
    }
    questions.push(item);
  }
  return questions;
};
