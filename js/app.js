'use strict';

const BOOK_LIST_PATH = 'books/books.json';
const AUDIO_MAP_PATH = 'audio/audio-map.json';
const MAX_CHOICES = 5;
const SENTENCE_PAUSE_MS = 500;
const PARAGRAPH_PAUSE_MS = 1000;
const NEXT_AFTER_ANSWER_MS = 240;
const PREFERRED_FEMALE_VOICES = ['sunhi', 'yuna', '유나', 'sora', '소라', 'heami', 'google 한국'];
const MALE_VOICE_NAMES = ['eddy', 'reed', 'rocko', 'grandpa', 'injoon', 'bongjin', 'hyunsu'];

const state = {
  books: [],
  audioMap: new Map(),
  book: null,
  chunks: [],
  targetsByParagraph: new Map(),
  revealed: new Set(),
  currentChunkIndex: 0,
  currentTarget: null,
  activeParagraphIndex: -1,
  readingToken: 0,
  currentAudio: null,
  koVoice: null,
  ghost: null,
  touchTile: null,
  touchStart: null,
  audioContext: null,
};

const els = {
  libraryScene: document.getElementById('scene-library'),
  readerScene: document.getElementById('scene-reader'),
  bookList: document.getElementById('book-list'),
  readerTitle: document.getElementById('reader-title'),
  storyPages: document.getElementById('story-pages'),
  choiceTray: document.getElementById('choice-tray'),
  illustrationFrame: document.getElementById('illustration-frame'),
  mainIllustration: document.getElementById('main-illustration'),
  completePanel: document.getElementById('complete-panel'),
  completeTitle: document.getElementById('complete-title'),
  home: document.getElementById('btn-home'),
  replay: document.getElementById('btn-replay'),
  readAgain: document.getElementById('btn-read-again'),
  library: document.getElementById('btn-library'),
};

function showScene(scene) {
  for (const el of [els.libraryScene, els.readerScene]) {
    el.classList.toggle('active', el === scene);
  }
}

function shuffle(items) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function wait(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function escapeForAttr(value) {
  return String(value).replace(/"/g, '&quot;');
}

async function fetchJson(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`${path} HTTP ${response.status}`);
  return response.json();
}

async function loadAudioMap() {
  try {
    const map = await fetchJson(AUDIO_MAP_PATH);
    state.audioMap = new Map(Object.entries(map));
  } catch (error) {
    console.warn('audio map unavailable', error);
    state.audioMap = new Map();
  }
}

async function loadLibrary() {
  const metas = await fetchJson(BOOK_LIST_PATH);
  const loaded = await Promise.all(metas.map(async (meta) => ({
    ...meta,
    detail: await fetchJson(meta.path),
  })));
  state.books = loaded;
  renderLibrary();
}

function renderLibrary() {
  els.bookList.textContent = '';
  for (const meta of state.books) {
    const button = document.createElement('button');
    button.className = 'book-card';
    button.type = 'button';
    button.innerHTML = `
      <img src="${escapeForAttr(meta.cover)}" alt="">
      <strong>${meta.title}</strong>
      <span>${meta.subtitle}</span>
    `;
    button.addEventListener('click', () => startBook(meta.detail));
    els.bookList.appendChild(button);
  }
}

function isWhitespace(ch) {
  return /\s/.test(ch);
}

function isSentenceEnd(ch) {
  return ch === '.' || ch === '!' || ch === '?' || ch === '。' || ch === '！' || ch === '？';
}

function findEojeolEnd(text, fromIndex) {
  for (let i = fromIndex; i < text.length; i += 1) {
    if (isWhitespace(text[i])) return i;
  }
  return text.length;
}

function findSentenceEnd(text, fromIndex, limit) {
  for (let i = fromIndex; i < limit; i += 1) {
    if (isSentenceEnd(text[i])) {
      let end = i + 1;
      while (end < limit && '”"’\''.includes(text[end])) end += 1;
      return end;
    }
  }
  return -1;
}

function analyzeTargets(book) {
  const byParagraph = new Map();
  book.paragraphs.forEach((paragraph, paragraphIndex) => {
    const targets = [];
    let cursor = 0;
    paragraph.quizWords.forEach((word, targetIndex) => {
      const start = paragraph.text.indexOf(word, cursor);
      if (start < 0) {
        console.warn(`Missing quiz word "${word}" in paragraph ${paragraph.id}`);
        return;
      }
      const wordEnd = start + word.length;
      const eojeolEnd = findEojeolEnd(paragraph.text, wordEnd);
      const target = {
        id: `${paragraph.id}-${targetIndex}`,
        paragraphId: paragraph.id,
        paragraphIndex,
        targetIndex,
        word,
        start,
        wordEnd,
        eojeolEnd,
      };
      targets.push(target);
      cursor = wordEnd;
    });
    byParagraph.set(paragraph.id, targets);
  });
  return byParagraph;
}

function pushNarrationChunks(chunks, paragraph, paragraphIndex, start, end, isLastParagraph) {
  let cursor = start;
  while (cursor < end) {
    const sentenceEnd = findSentenceEnd(paragraph.text, cursor, end);
    const nextEnd = sentenceEnd > -1 ? sentenceEnd : end;
    const text = paragraph.text.slice(cursor, nextEnd).trim();
    if (text) {
      chunks.push({
        kind: 'narration',
        paragraphId: paragraph.id,
        paragraphIndex,
        text,
        sentenceEnd: sentenceEnd > -1,
        paragraphEnd: nextEnd >= paragraph.text.length && isLastParagraph,
      });
    }
    cursor = nextEnd;
  }
}

function pushCompleteSentenceChunksBeforeTarget(chunks, paragraph, paragraphIndex, start, targetStart) {
  let cursor = start;
  while (cursor < targetStart) {
    const sentenceEnd = findSentenceEnd(paragraph.text, cursor, targetStart);
    if (sentenceEnd < 0) break;
    const text = paragraph.text.slice(cursor, sentenceEnd).trim();
    if (text) {
      chunks.push({
        kind: 'narration',
        paragraphId: paragraph.id,
        paragraphIndex,
        text,
        sentenceEnd: true,
        paragraphEnd: false,
      });
    }
    cursor = sentenceEnd;
  }
  return cursor;
}

function buildChunks(book, targetsByParagraph) {
  const chunks = [];
  book.paragraphs.forEach((paragraph, paragraphIndex) => {
    const targets = targetsByParagraph.get(paragraph.id) || [];
    let cursor = 0;
    targets.forEach((target) => {
      cursor = pushCompleteSentenceChunksBeforeTarget(chunks, paragraph, paragraphIndex, cursor, target.start);
      const text = paragraph.text.slice(cursor, target.eojeolEnd).trim();
      if (text) {
        chunks.push({
          kind: 'target',
          paragraphId: paragraph.id,
          paragraphIndex,
          target,
          text,
          sentenceEnd: isSentenceEnd(paragraph.text[target.eojeolEnd - 1]),
          paragraphEnd: target.eojeolEnd >= paragraph.text.length,
        });
      }
      cursor = target.eojeolEnd;
    });
    pushNarrationChunks(chunks, paragraph, paragraphIndex, cursor, paragraph.text.length, true);
    const lastChunk = chunks[chunks.length - 1];
    if (lastChunk && lastChunk.paragraphId === paragraph.id) {
      lastChunk.paragraphEnd = true;
    }
  });
  return chunks;
}

function startBook(book) {
  unlockAudio();
  cancelSpeech();
  state.book = book;
  state.targetsByParagraph = analyzeTargets(book);
  state.chunks = buildChunks(book, state.targetsByParagraph);
  state.revealed = new Set();
  state.currentChunkIndex = 0;
  state.currentTarget = null;
  state.activeParagraphIndex = -1;
  els.readerTitle.textContent = book.title;
  els.completePanel.classList.add('hidden');
  renderStory();
  renderChoices();
  showScene(els.readerScene);
  updateIllustration(0, true);
  playFrom(0);
}

function restartBook() {
  if (state.book) startBook(state.book);
}

function targetForBlank(paragraphId, targetId) {
  const targets = state.targetsByParagraph.get(paragraphId) || [];
  return targets.find((target) => target.id === targetId) || null;
}

function renderStory() {
  els.storyPages.textContent = '';
  if (!state.book) return;
  state.book.paragraphs.forEach((paragraph, paragraphIndex) => {
    const row = document.createElement('article');
    row.className = 'paragraph';
    row.classList.toggle('active', paragraphIndex === state.activeParagraphIndex);
    row.dataset.paragraphId = paragraph.id;

    const thumb = document.createElement('img');
    thumb.src = paragraph.image;
    thumb.alt = '';
    row.appendChild(thumb);

    const textEl = document.createElement('p');
    textEl.className = 'paragraph-text';
    const targets = state.targetsByParagraph.get(paragraph.id) || [];
    let cursor = 0;
    targets.forEach((target) => {
      if (target.start > cursor) {
        textEl.appendChild(document.createTextNode(paragraph.text.slice(cursor, target.start)));
      }
      const blank = document.createElement('span');
      blank.className = 'blank';
      blank.dataset.targetId = target.id;
      blank.dataset.word = target.word;
      blank.setAttribute('aria-label', `${target.word} 빈칸`);
      if (state.revealed.has(target.id)) {
        blank.classList.add('filled');
        blank.textContent = target.word;
      }
      if (state.currentTarget?.target.id === target.id) {
        blank.classList.add('current');
      }
      textEl.appendChild(blank);
      cursor = target.wordEnd;
    });
    if (cursor < paragraph.text.length) {
      textEl.appendChild(document.createTextNode(paragraph.text.slice(cursor)));
    }
    row.appendChild(textEl);
    els.storyPages.appendChild(row);
  });
}

function buildChoices(answer) {
  const base = [
    ...(state.book.targetWords || []),
    ...(state.book.distractorWords || []),
  ].filter((word) => word && word !== answer);
  const uniqueDistractors = [...new Set(base)];
  const choices = [answer, ...shuffle(uniqueDistractors).slice(0, MAX_CHOICES - 1)];
  return shuffle(choices);
}

function renderChoices() {
  els.choiceTray.textContent = '';
  const target = state.currentTarget?.target;
  els.choiceTray.classList.toggle('waiting', !target);
  if (!target) return;

  for (const word of buildChoices(target.word)) {
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = 'choice-tile';
    tile.textContent = word;
    tile.dataset.word = word;
    tile.draggable = true;
    attachTileEvents(tile);
    els.choiceTray.appendChild(tile);
  }
}

function attachTileEvents(tile) {
  tile.addEventListener('click', () => speakText(tile.dataset.word));
  tile.addEventListener('dragstart', (event) => {
    event.dataTransfer.setData('text/plain', tile.dataset.word);
    event.dataTransfer.effectAllowed = 'move';
    tile.classList.add('dragging');
  });
  tile.addEventListener('dragend', () => tile.classList.remove('dragging'));
  tile.addEventListener('touchstart', (event) => onTouchStart(event, tile), { passive: false });
}

function setupDropZone() {
  els.storyPages.addEventListener('dragover', (event) => {
    const blank = event.target.closest('.blank.current');
    if (!blank) return;
    event.preventDefault();
    blank.classList.add('hover');
    event.dataTransfer.dropEffect = 'move';
  });

  els.storyPages.addEventListener('dragleave', (event) => {
    const blank = event.target.closest('.blank.current');
    if (blank) blank.classList.remove('hover');
  });

  els.storyPages.addEventListener('drop', (event) => {
    const blank = event.target.closest('.blank.current');
    if (!blank) return;
    event.preventDefault();
    blank.classList.remove('hover');
    judgeAnswer(event.dataTransfer.getData('text/plain'));
  });
}

function onTouchStart(event, tile) {
  if (!state.currentTarget || state.touchTile) return;
  event.preventDefault();
  unlockAudio();
  const touch = event.touches[0];
  state.touchTile = tile;
  state.touchStart = { id: touch.identifier, x: touch.clientX, y: touch.clientY };
  state.ghost = tile.cloneNode(true);
  state.ghost.classList.add('touch-ghost');
  document.body.appendChild(state.ghost);
  moveGhost(touch);
  tile.classList.add('dragging');
  document.addEventListener('touchmove', onTouchMove, { passive: false });
  document.addEventListener('touchend', onTouchEnd);
  document.addEventListener('touchcancel', onTouchEnd);
}

function trackedTouch(list) {
  if (!state.touchStart) return null;
  return Array.from(list).find((touch) => touch.identifier === state.touchStart.id) || null;
}

function moveGhost(touch) {
  if (!state.ghost) return;
  state.ghost.style.left = `${touch.clientX}px`;
  state.ghost.style.top = `${touch.clientY}px`;
}

function blankUnderTouch(touch) {
  const element = document.elementFromPoint(touch.clientX, touch.clientY);
  return element?.closest('.blank.current') || null;
}

function onTouchMove(event) {
  const touch = trackedTouch(event.touches);
  if (!touch) return;
  event.preventDefault();
  moveGhost(touch);
}

function onTouchEnd(event) {
  const touch = trackedTouch(event.changedTouches);
  if (!touch) return;
  document.removeEventListener('touchmove', onTouchMove);
  document.removeEventListener('touchend', onTouchEnd);
  document.removeEventListener('touchcancel', onTouchEnd);

  const blank = blankUnderTouch(touch);
  const tile = state.touchTile;
  const moved = state.touchStart
    ? Math.hypot(touch.clientX - state.touchStart.x, touch.clientY - state.touchStart.y)
    : 0;
  cleanupTouch();

  if (blank && tile) {
    judgeAnswer(tile.dataset.word);
  } else if (tile && moved < 12) {
    speakText(tile.dataset.word);
  }
}

function cleanupTouch() {
  if (state.touchTile) state.touchTile.classList.remove('dragging');
  if (state.ghost) state.ghost.remove();
  state.touchTile = null;
  state.touchStart = null;
  state.ghost = null;
}

function judgeAnswer(word) {
  const target = state.currentTarget?.target;
  if (!target) return;
  if (word === target.word) {
    playDing();
    state.revealed.add(target.id);
    state.currentTarget = null;
    renderStory();
    renderChoices();
    const completedChunk = state.chunks[state.currentChunkIndex];
    const pause = completedChunk?.paragraphEnd
      ? PARAGRAPH_PAUSE_MS
      : completedChunk?.sentenceEnd
        ? SENTENCE_PAUSE_MS
        : NEXT_AFTER_ANSWER_MS;
    wait(pause).then(() => playFrom(state.currentChunkIndex + 1));
    return;
  }
  playWrong();
  for (const tile of els.choiceTray.querySelectorAll('.choice-tile')) {
    if (tile.dataset.word === word) {
      tile.classList.remove('wrong');
      void tile.offsetWidth;
      tile.classList.add('wrong');
    }
  }
}

function updateIllustration(paragraphIndex, immediate = false) {
  if (!state.book || paragraphIndex === state.activeParagraphIndex && !immediate) return;
  const paragraph = state.book.paragraphs[paragraphIndex];
  if (!paragraph) return;
  state.activeParagraphIndex = paragraphIndex;
  renderStory();
  if (immediate || !els.mainIllustration.src) {
    els.mainIllustration.src = paragraph.image;
    els.mainIllustration.alt = `${state.book.title} 삽화`;
    return;
  }
  els.illustrationFrame.classList.add('fading');
  window.setTimeout(() => {
    els.mainIllustration.src = paragraph.image;
    els.mainIllustration.alt = `${state.book.title} 삽화`;
    els.illustrationFrame.classList.remove('fading');
  }, 180);
}

async function playFrom(index) {
  if (!state.book) return;
  const token = state.readingToken + 1;
  state.readingToken = token;
  state.currentTarget = null;
  renderChoices();

  for (let i = index; i < state.chunks.length; i += 1) {
    if (state.readingToken !== token) return;
    const chunk = state.chunks[i];
    state.currentChunkIndex = i;
    updateIllustration(chunk.paragraphIndex);
    if (chunk.kind === 'target') {
      state.currentTarget = chunk;
      renderStory();
      renderChoices();
      await speakText(chunk.text);
      return;
    }
    renderStory();
    await speakText(chunk.text);
    if (state.readingToken !== token) return;
    const pause = chunk.paragraphEnd ? PARAGRAPH_PAUSE_MS : chunk.sentenceEnd ? SENTENCE_PAUSE_MS : 0;
    if (pause > 0) await wait(pause);
  }
  completeBook();
}

function completeBook() {
  state.currentTarget = null;
  renderStory();
  renderChoices();
  els.completeTitle.textContent = `${state.book.title} 끝!`;
  els.completePanel.classList.remove('hidden');
  speakText('끝까지 읽었어요. 참 잘했어요!');
}

function stopReading() {
  state.readingToken += 1;
  cancelSpeech();
}

function replayCurrent() {
  if (!state.book) return;
  stopReading();
  const index = state.currentTarget ? state.currentChunkIndex : Math.max(0, state.currentChunkIndex);
  playFrom(index);
}

function unlockAudio() {
  if (!state.audioContext) {
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    if (AudioContextCtor) state.audioContext = new AudioContextCtor();
  }
  if (state.audioContext?.state === 'suspended') {
    state.audioContext.resume().catch(() => {});
  }
}

function playToneSequence(steps) {
  unlockAudio();
  const context = state.audioContext;
  if (!context) return;
  const start = context.currentTime + 0.01;
  steps.forEach((step, index) => {
    const osc = context.createOscillator();
    const gain = context.createGain();
    osc.type = step.type || 'sine';
    osc.frequency.setValueAtTime(step.freq, start + index * step.gap);
    gain.gain.setValueAtTime(0.0001, start + index * step.gap);
    gain.gain.exponentialRampToValueAtTime(step.gain, start + index * step.gap + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + index * step.gap + step.duration);
    osc.connect(gain).connect(context.destination);
    osc.start(start + index * step.gap);
    osc.stop(start + index * step.gap + step.duration + 0.03);
  });
}

function playDing() {
  playToneSequence([
    { freq: 740, gain: 0.14, duration: 0.16, gap: 0.16 },
    { freq: 980, gain: 0.16, duration: 0.22, gap: 0.16 },
  ]);
}

function playWrong() {
  playToneSequence([
    { freq: 220, gain: 0.14, duration: 0.2, gap: 0.18, type: 'triangle' },
    { freq: 165, gain: 0.12, duration: 0.22, gap: 0.18, type: 'triangle' },
  ]);
}

function cancelSpeech() {
  if (state.currentAudio) {
    state.currentAudio.pause();
    state.currentAudio.currentTime = 0;
    state.currentAudio = null;
  }
  if (window.speechSynthesis) window.speechSynthesis.cancel();
}

function pickKoreanVoice() {
  const voices = (window.speechSynthesis?.getVoices() || [])
    .filter((voice) => voice.lang?.toLowerCase().startsWith('ko'));
  if (!voices.length) return null;

  const preferred = PREFERRED_FEMALE_VOICES
    .map((hint) => voices.find((voice) => voice.name.toLowerCase().includes(hint)))
    .find(Boolean);
  if (preferred) return preferred;

  return voices.find((voice) => !MALE_VOICE_NAMES.some((hint) => voice.name.toLowerCase().includes(hint)))
    || voices[0];
}

function speakWithBrowser(text) {
  return new Promise((resolve) => {
    if (!window.speechSynthesis || !window.SpeechSynthesisUtterance) {
      resolve();
      return;
    }
    window.speechSynthesis.cancel();
    if (!state.koVoice) state.koVoice = pickKoreanVoice();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'ko-KR';
    utterance.rate = 0.86;
    utterance.pitch = 1.08;
    if (state.koVoice) utterance.voice = state.koVoice;
    utterance.onend = resolve;
    utterance.onerror = resolve;
    window.speechSynthesis.speak(utterance);
  });
}

function speakText(text) {
  cancelSpeech();
  const audioPath = state.audioMap.get(text);
  if (!audioPath) return speakWithBrowser(text);
  return new Promise((resolve) => {
    const audio = new Audio(audioPath);
    state.currentAudio = audio;
    audio.addEventListener('ended', () => {
      if (state.currentAudio === audio) state.currentAudio = null;
      resolve();
    });
    audio.addEventListener('error', () => {
      if (state.currentAudio === audio) state.currentAudio = null;
      speakWithBrowser(text).then(resolve);
    });
    audio.play().catch(() => {
      if (state.currentAudio === audio) state.currentAudio = null;
      speakWithBrowser(text).then(resolve);
    });
  });
}

function goHome() {
  stopReading();
  cleanupTouch();
  els.completePanel.classList.add('hidden');
  showScene(els.libraryScene);
}

function bindControls() {
  setupDropZone();
  els.home.addEventListener('click', goHome);
  els.library.addEventListener('click', goHome);
  els.replay.addEventListener('click', replayCurrent);
  els.readAgain.addEventListener('click', restartBook);
  if (window.speechSynthesis) {
    window.speechSynthesis.onvoiceschanged = () => {
      state.koVoice = pickKoreanVoice();
    };
  }
}

function installDebugApi() {
  window.__HANGUL_STORY__ = {
    snapshot() {
      return {
        bookId: state.book?.id || null,
        currentChunkIndex: state.currentChunkIndex,
        currentTarget: state.currentTarget?.target.word || null,
        currentTargetId: state.currentTarget?.target.id || null,
        activeParagraphIndex: state.activeParagraphIndex,
        revealed: [...state.revealed],
        choiceCount: els.choiceTray.querySelectorAll('.choice-tile').length,
        choices: [...els.choiceTray.querySelectorAll('.choice-tile')].map((tile) => tile.dataset.word),
        illustration: els.mainIllustration.getAttribute('src'),
      };
    },
    chooseBook(id = 'bremen') {
      const meta = state.books.find((book) => book.id === id);
      if (meta) startBook(meta.detail);
    },
    answer(word) {
      judgeAnswer(word);
    },
    replayCurrent,
  };
}

async function main() {
  bindControls();
  installDebugApi();
  await Promise.all([loadAudioMap(), loadLibrary()]);
}

main().catch((error) => {
  console.error(error);
  els.bookList.textContent = '책을 불러오지 못했어요.';
});
