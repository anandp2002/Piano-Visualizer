// PianoKeyboard.jsx
import React, {
  useState,
  useRef,
  useEffect,
  useCallback,
  useLayoutEffect,
} from 'react';
import * as Tone from 'tone';
import { Midi } from '@tonejs/midi';
import {
  KEYS,
  WHITE_KEYS,
  BLACK_KEYS,
  NUM_WHITE_KEYS,
  COMPUTER_KEY_TO_NOTE,
} from '../utils/keys';

// --- Constants ---
const BLACK_KEY_WIDTH_RATIO = 0.65;
const KEYBOARD_HEIGHT = 256;
const ANIMATION_AREA_HEIGHT = 300;
// Free Play Constants
const NOTE_RISE_SPEED_PPS = 120; // Pixels per second
const NOTE_FADEOUT_DURATION_MS = 5000;
// Assisted Play Constants
const NOTE_FALL_SPEED_PPS = 100; // Pixels per second
const FEEDBACK_DURATION_MS = 400;

// --- Custom Hook for observing element resizing ---
const useResizeObserver = (ref) => {
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const resizeObserver = new ResizeObserver((entries) => {
      if (!entries || entries.length === 0) return;
      const { width, height } = entries[0].contentRect;
      setDimensions({ width, height });
    });
    resizeObserver.observe(element);
    return () => resizeObserver.disconnect();
  }, [ref]);
  return dimensions;
};

const PianoKeyboard = () => {
  // --- State ---
  const [pressedKeys, setPressedKeys] = useState(new Set());
  const [keyDimensions, setKeyDimensions] = useState({
    whiteKeyWidth: 0,
    blackKeyWidth: 0,
  });
  const [midiWarning, setMidiWarning] = useState('');
  const [midiDeviceName, setMidiDeviceName] = useState(
    'No MIDI device connected.'
  );
  const [keyFeedback, setKeyFeedback] = useState(new Map());

  // --- Practice Mode State ---
  const [practiceMode, setPracticeMode] = useState('free');
  const [gameState, setGameState] = useState('idle'); // idle, playing, paused, waitingForInput, finished
  const [rawSongNotes, setRawSongNotes] = useState(null);
  const [visualSongNotes, setVisualSongNotes] = useState([]);
  const [score, setScore] = useState({ hits: 0, mistakes: 0 });
  const [midiFileName, setMidiFileName] = useState(null);

  // --- Refs ---
  const synth = useRef(null);
  const animationFrameRef = useRef(null);
  const keyboardContainerRef = useRef(null);
  const feedbackTimeoutRefs = useRef(new Map());

  // Free Play Refs (mutable state that doesn't trigger re-renders)
  const freePlayNoteIdCounter = useRef(0);
  const activeFreePlayNotes = useRef(new Map());
  const heldKeysRef = useRef(new Set());

  // Assisted Play Refs (mutable state that doesn't trigger re-renders)
  const songData = useRef(null);
  const activelyHeldAssistedNotes = useRef(new Map());
  const songTime = useRef(0);
  const lastTimestamp = useRef(0);
  const waitingNotes = useRef([]);
  const prePauseGameState = useRef('idle');

  // --- Measure container and calculate responsive key sizes ---
  const { width: containerWidth } = useResizeObserver(keyboardContainerRef);
  useEffect(() => {
    if (containerWidth > 0) {
      const whiteKeyWidth = containerWidth / NUM_WHITE_KEYS;
      const blackKeyWidth = whiteKeyWidth * BLACK_KEY_WIDTH_RATIO;
      setKeyDimensions({ whiteKeyWidth, blackKeyWidth });
    }
  }, [containerWidth]);

  // --- 1. Initialize Audio ---
  useEffect(() => {
    synth.current = new Tone.PolySynth(Tone.Synth, {
      oscillator: {
        type: 'fmtriangle',
        harmonicity: 0.5,
        modulationType: 'sine',
      },
      envelope: { attack: 0.01, decay: 0.1, sustain: 0.4, release: 2 },
    }).toDestination();

    return () => {
      synth.current?.dispose();
      feedbackTimeoutRefs.current.forEach((timeoutId) =>
        clearTimeout(timeoutId)
      );
    };
  }, []);

  // --- Provides visual feedback on key presses (hit, mistake) ---
  const addKeyFeedback = useCallback((noteName, status) => {
    if (feedbackTimeoutRefs.current.has(noteName)) {
      clearTimeout(feedbackTimeoutRefs.current.get(noteName));
    }
    setKeyFeedback((prev) => new Map(prev).set(noteName, status));
    const timeoutId = setTimeout(() => {
      setKeyFeedback((prev) => {
        const newMap = new Map(prev);
        if (newMap.get(noteName) === status) {
          newMap.delete(noteName);
        }
        return newMap;
      });
      feedbackTimeoutRefs.current.delete(noteName);
    }, FEEDBACK_DURATION_MS);

    feedbackTimeoutRefs.current.set(noteName, timeoutId);
  }, []);

  // --- Main Animation Loop ---
  useEffect(() => {
    const animationLoop = (now) => {
      const delta =
        lastTimestamp.current > 0 ? (now - lastTimestamp.current) / 1000 : 0;
      lastTimestamp.current = now;

      // Logic for Assisted Practice Mode (falling notes)
      if (
        practiceMode === 'assisted' &&
        (gameState === 'playing' || gameState === 'waitingForInput')
      ) {
        if (gameState === 'playing') {
          songTime.current += delta;
        }

        if (gameState === 'waitingForInput') {
          const currentTime = performance.now();
          activelyHeldAssistedNotes.current.forEach((heldNote) => {
            if (
              heldNote.status === 'holding' &&
              (currentTime - heldNote.pressStartTime) / 1000 >=
                heldNote.duration
            ) {
              heldNote.status = 'hit'; // Mark as successfully held
            }
          });
        }

        const elapsedTimeS = songTime.current;
        const notesToDisplay = [];
        const upcomingNotes =
          songData.current?.filter((n) => n.status === 'upcoming') || [];

        if (gameState === 'playing' && upcomingNotes.length > 0) {
          const nextNoteTime = upcomingNotes[0].time;
          if (elapsedTimeS >= nextNoteTime) {
            songTime.current = nextNoteTime;
            const notesToWaitFor = upcomingNotes.filter(
              (n) => n.time === nextNoteTime
            );
            notesToWaitFor.forEach((n) => (n.status = 'waiting'));
            waitingNotes.current = notesToWaitFor;
            setGameState('waitingForInput');
          }
        }

        if (songData.current) {
          songData.current.forEach((note) => {
            if (note.status === 'finished') return;
            const timeToSpawn =
              note.time - ANIMATION_AREA_HEIGHT / NOTE_FALL_SPEED_PPS;
            if (elapsedTimeS >= timeToSpawn) {
              const noteHeight = note.duration * NOTE_FALL_SPEED_PPS;
              const y =
                (elapsedTimeS - note.time) * NOTE_FALL_SPEED_PPS +
                ANIMATION_AREA_HEIGHT;
              note.y = y;
              const noteTopY = y - noteHeight;
              if (noteTopY >= ANIMATION_AREA_HEIGHT) {
                note.status = 'finished';
              } else {
                notesToDisplay.push(note);
              }
            }
          });
        }
        setVisualSongNotes(notesToDisplay);

        if (
          upcomingNotes.length === 0 &&
          waitingNotes.current.length === 0 &&
          notesToDisplay.length === 0
        ) {
          setGameState('finished');
        }
      }
      // Logic for Free Play Mode (rising notes)
      else if (practiceMode === 'free') {
        const notesToDelete = [];
        activeFreePlayNotes.current.forEach((note) => {
          if (!note.element || !note.visualBarElement) return;

          if (!note.endTime) {
            const durationMs = now - note.startTime;
            note.currentDuration = durationMs / 1000;
            note.visualBarElement.style.height = `${
              note.currentDuration * NOTE_RISE_SPEED_PPS
            }px`;
            // *** NEW: Update duration text on every frame ***
            if (note.durationElement) {
              note.durationElement.textContent = `${note.currentDuration.toFixed(
                2
              )}s`;
            }
          } else {
            const timeSinceRelease = now - note.endTime;
            const slideDistance =
              (timeSinceRelease / 1000) * NOTE_RISE_SPEED_PPS;
            note.element.style.transform = `translateY(${-slideDistance}px)`;
            const opacity = 1 - timeSinceRelease / NOTE_FADEOUT_DURATION_MS;
            note.element.style.opacity = Math.max(0, opacity * 0.9).toString();
            if (slideDistance > ANIMATION_AREA_HEIGHT) {
              notesToDelete.push(note.id);
            }
          }
        });
        if (notesToDelete.length > 0) {
          notesToDelete.forEach((id) => activeFreePlayNotes.current.delete(id));
          setVisualSongNotes(Array.from(activeFreePlayNotes.current.values()));
        }
      }
      animationFrameRef.current = requestAnimationFrame(animationLoop);
    };

    animationFrameRef.current = requestAnimationFrame(animationLoop);
    return () => cancelAnimationFrame(animationFrameRef.current);
  }, [practiceMode, gameState]);

  // --- Calculate note positions only when dimensions are ready ---
  useEffect(() => {
    if (!rawSongNotes || keyDimensions.whiteKeyWidth === 0) {
      return;
    }

    const { whiteKeyWidth, blackKeyWidth } = keyDimensions;
    const processedNotes = rawSongNotes
      .map((note) => {
        const keyData = KEYS.find((k) => k.midi === note.midi);
        if (!keyData) return null;
        const isBlackKey = keyData.type === 'black';
        return {
          ...note,
          left: isBlackKey
            ? (keyData.whiteKeyIndex + 1) * whiteKeyWidth - blackKeyWidth / 2
            : keyData.whiteKeyIndex * whiteKeyWidth,
          width: isBlackKey ? blackKeyWidth : whiteKeyWidth,
        };
      })
      .filter(Boolean);

    songData.current = processedNotes;
    setVisualSongNotes([]);
  }, [rawSongNotes, keyDimensions]);

  // --- Note Handlers (called by MIDI, mouse, or keyboard) ---
  const handleNoteOn = useCallback(
    (keyData) => {
      if (heldKeysRef.current.has(keyData.note)) return;
      Tone.start().catch((e) => console.error('Tone.js start error:', e));
      synth.current.triggerAttack(keyData.note);
      heldKeysRef.current.add(keyData.note);
      setPressedKeys((prev) => new Set(prev).add(keyData.note));

      if (practiceMode === 'assisted') {
        if (gameState !== 'playing' && gameState !== 'waitingForInput') return;

        const waitingNote = waitingNotes.current.find(
          (n) => n.name === keyData.note && n.status === 'waiting'
        );

        if (waitingNote) {
          waitingNote.status = 'holding';
          waitingNote.pressStartTime = performance.now();
          activelyHeldAssistedNotes.current.set(keyData.note, waitingNote);
          addKeyFeedback(keyData.note, 'hit');
        } else if (
          gameState === 'waitingForInput' &&
          !activelyHeldAssistedNotes.current.has(keyData.note)
        ) {
          setScore((s) => ({ ...s, mistakes: s.mistakes + 1 }));
          addKeyFeedback(keyData.note, 'mistake');
        }
      } else if (practiceMode === 'free') {
        const { whiteKeyWidth, blackKeyWidth } = keyDimensions;
        if (whiteKeyWidth === 0) return;
        const noteId = ++freePlayNoteIdCounter.current;
        const isBlackKey = keyData.type === 'black';
        const left = isBlackKey
          ? (keyData.whiteKeyIndex + 1) * whiteKeyWidth - blackKeyWidth / 2
          : keyData.whiteKeyIndex * whiteKeyWidth;
        const newVisualNote = {
          id: noteId,
          noteName: keyData.note,
          startTime: performance.now(),
          endTime: null,
          element: null,
          visualBarElement: null,
          durationElement: null, // *** NEW: Add ref for duration text ***
          left: left,
          width: isBlackKey ? blackKeyWidth : whiteKeyWidth,
          color: isBlackKey ? '#8b5cf6' : '#3b82f6',
          currentDuration: 0,
        };
        activeFreePlayNotes.current.set(noteId, newVisualNote);
        setVisualSongNotes(Array.from(activeFreePlayNotes.current.values()));
      }
    },
    [practiceMode, gameState, addKeyFeedback, keyDimensions]
  );

  const handleNoteOff = useCallback(
    (keyData) => {
      if (!heldKeysRef.current.has(keyData.note)) return;
      synth.current.triggerRelease(keyData.note);
      heldKeysRef.current.delete(keyData.note);
      setPressedKeys((prev) => {
        const newSet = new Set(prev);
        newSet.delete(keyData.note);
        return newSet;
      });

      if (practiceMode === 'assisted') {
        if (activelyHeldAssistedNotes.current.has(keyData.note)) {
          const heldNoteData = activelyHeldAssistedNotes.current.get(
            keyData.note
          );
          activelyHeldAssistedNotes.current.delete(keyData.note);

          if (heldNoteData.status === 'hit') {
            setScore((s) => ({ ...s, hits: s.hits + 1 }));
            waitingNotes.current = waitingNotes.current.filter(
              (n) => n.id !== heldNoteData.id
            );
            if (
              waitingNotes.current.length === 0 &&
              gameState === 'waitingForInput'
            ) {
              setGameState('playing');
            }
          } else if (heldNoteData.status === 'holding') {
            setScore((s) => ({ ...s, mistakes: s.mistakes + 1 }));
            addKeyFeedback(keyData.note, 'mistake');
            heldNoteData.status = 'waiting';
            delete heldNoteData.pressStartTime;
          }
        }
      } else if (practiceMode === 'free') {
        const now = performance.now();
        activeFreePlayNotes.current.forEach((note) => {
          if (note.noteName === keyData.note && !note.endTime) {
            note.endTime = now;
          }
        });
      }
    },
    [practiceMode, gameState, addKeyFeedback]
  );

  // --- MIDI & Keyboard Input ---
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.repeat) return;
      const noteName = COMPUTER_KEY_TO_NOTE[e.code];
      if (noteName) {
        const keyData = KEYS.find((k) => k.note === noteName);
        if (keyData) handleNoteOn(keyData);
      }
    };
    const handleKeyUp = (e) => {
      const noteName = COMPUTER_KEY_TO_NOTE[e.code];
      if (noteName) {
        const keyData = KEYS.find((k) => k.note === noteName);
        if (keyData) handleNoteOff(keyData);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);

    if (!navigator.requestMIDIAccess) {
      setMidiWarning('Web MIDI API not supported. Please use Chrome or Edge.');
      return;
    }
    let midiAccess;
    const onMIDIMessage = (message) => {
      const [command, noteMidi, velocity] = message.data;
      const keyData = KEYS.find((k) => k.midi === noteMidi);
      if (!keyData) return;
      if (command === 144 && velocity > 0) handleNoteOn(keyData);
      else if (command === 128 || (command === 144 && velocity === 0))
        handleNoteOff(keyData);
    };
    const updateMidiDevices = (midi) => {
      const inputs = Array.from(midi.inputs.values());
      inputs.forEach((input) => (input.onmidimessage = onMIDIMessage));
      const deviceNames = inputs.map((i) => i.name).join(', ');
      setMidiDeviceName(
        deviceNames ? `Connected: ${deviceNames}` : 'No MIDI device connected.'
      );
      setMidiWarning('');
    };
    navigator.requestMIDIAccess().then((midi) => {
      midiAccess = midi;
      updateMidiDevices(midi);
      midiAccess.onstatechange = () => updateMidiDevices(midiAccess);
    });

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      if (midiAccess) {
        midiAccess.onstatechange = null;
        midiAccess.inputs.forEach((input) => (input.onmidimessage = null));
      }
    };
  }, [handleNoteOn, handleNoteOff]);

  // --- Game Controls ---
  const resetAssistedPracticeState = () => {
    setScore({ hits: 0, mistakes: 0 });
    setKeyFeedback(new Map());
    activelyHeldAssistedNotes.current.clear();
    if (songData.current) {
      songData.current.forEach((n) => {
        n.status = 'upcoming';
        n.y = 0;
        delete n.pressStartTime;
      });
    }
    songTime.current = 0;
    lastTimestamp.current = 0;
    waitingNotes.current = [];
    prePauseGameState.current = 'idle';
  };

  const handleFileChange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setMidiFileName(file.name);
    setGameState('idle');
    setPracticeMode('assisted');
    const arrayBuffer = await file.arrayBuffer();
    const midi = new Midi(arrayBuffer);
    let noteCounter = 0;

    const notes = midi.tracks
      .flatMap((track) => track.notes)
      .map((note) => ({
        id: noteCounter++,
        name: note.name,
        midi: note.midi,
        time: note.time,
        duration: note.duration,
        status: 'upcoming',
        y: 0,
      }))
      .filter((note) => KEYS.some((k) => k.midi === note.midi))
      .sort((a, b) => a.time - b.time);

    songData.current = null;
    setVisualSongNotes([]);
    resetAssistedPracticeState();
    setRawSongNotes(notes);
    e.target.value = '';
  };

  const startAssistedPractice = () => {
    if (!songData.current || songData.current.length === 0) return;
    resetAssistedPracticeState();
    setGameState('playing');
    lastTimestamp.current = performance.now();
  };

  const handlePlayControls = () => {
    if (gameState === 'playing' || gameState === 'waitingForInput') {
      prePauseGameState.current = gameState;
      setGameState('paused');
    } else if (gameState === 'paused') {
      lastTimestamp.current = performance.now();
      setGameState(prePauseGameState.current);
    } else {
      startAssistedPractice();
    }
  };

  const getPlayButtonText = () => {
    if (gameState === 'finished') return 'Play Again';
    if (gameState === 'playing' || gameState === 'waitingForInput')
      return 'Pause';
    if (gameState === 'paused') return 'Resume';
    return 'Start';
  };

  const switchToFreePlay = () => {
    setPracticeMode('free');
    setGameState('idle');
    setRawSongNotes(null);
    songData.current = null;
    setVisualSongNotes([]);
    activeFreePlayNotes.current.clear();
    setMidiFileName(null);
  };

  // --- Dynamic Styling ---
  const getNoteColor = (status, keyType) => {
    if (status === 'hit') return '#10b981'; // Green
    if (status === 'waiting' || status === 'holding') return '#facc15'; // Yellow
    return keyType === 'black' ? '#8b5cf6' : '#3b82f6'; // Purple / Blue
  };

  const getKeyClasses = (key) => {
    const isWaiting =
      gameState === 'waitingForInput' &&
      waitingNotes.current.some(
        (n) =>
          n.name === key.note &&
          (n.status === 'waiting' || n.status === 'holding')
      );

    const feedback = keyFeedback.get(key.note);
    const isPressed = pressedKeys.has(key.note);
    const pressedClass =
      key.type === 'white' ? 'translate-y-1 shadow-inner' : 'h-[9.8rem]';

    if (isWaiting) return `bg-yellow-400 animate-pulse ${pressedClass}`;
    if (feedback === 'hit') return `bg-green-300 ${pressedClass}`;
    if (feedback === 'mistake') return `bg-red-300 ${pressedClass}`;
    if (isPressed)
      return `${
        key.type === 'white' ? 'bg-blue-300' : 'bg-purple-600'
      } ${pressedClass}`;
    return key.type === 'white'
      ? 'bg-white hover:bg-gray-100'
      : 'bg-gray-800 hover:bg-gray-700';
  };

  // --- Render ---
  return (
    <div
      ref={keyboardContainerRef}
      className="bg-gray-800 p-4 rounded-lg shadow-2xl w-full select-none"
    >
      {/* --- Controls Header --- */}
      <div className="flex justify-between items-center mb-4 text-white">
        <div className="flex gap-2">
          <button
            onClick={switchToFreePlay}
            className={`px-4 py-2 rounded text-sm font-bold transition-colors ${
              practiceMode === 'free'
                ? 'bg-blue-600'
                : 'bg-gray-600 hover:bg-gray-500'
            }`}
          >
            Free Practice
          </button>
          <label
            className={`px-4 py-2 rounded text-sm font-bold cursor-pointer transition-colors ${
              practiceMode === 'assisted'
                ? 'bg-purple-600'
                : 'bg-gray-600 hover:bg-gray-500'
            }`}
          >
            Load MIDI
            <input
              type="file"
              accept=".mid,.midi"
              onChange={handleFileChange}
              className="hidden"
            />
          </label>
          {practiceMode === 'assisted' && rawSongNotes && (
            <button
              onClick={handlePlayControls}
              className={`px-4 py-2 rounded text-sm font-bold transition-colors w-28 ${
                gameState === 'playing' || gameState === 'waitingForInput'
                  ? 'bg-yellow-600 hover:bg-yellow-500'
                  : 'bg-green-600 hover:bg-green-500'
              }`}
            >
              {getPlayButtonText()}
            </button>
          )}
        </div>
        {practiceMode === 'assisted' && rawSongNotes && (
          <div className="flex gap-4 font-mono text-sm">
            <span>
              <span className="text-green-400">Hits:</span> {score.hits}
            </span>
            <span>
              <span className="text-red-400">Mistakes:</span> {score.mistakes}
            </span>
          </div>
        )}
      </div>

      {/* --- Song Info & MIDI Status --- */}
      {practiceMode === 'assisted' && midiFileName && (
        <div className="text-center text-gray-300 text-sm mb-2 font-mono truncate">
          Now Playing:{' '}
          <span className="font-bold text-purple-300">{midiFileName}</span>
        </div>
      )}
      <div
        className={`p-2 rounded-md text-center text-sm mb-2 transition-all duration-300 ${
          midiWarning
            ? 'bg-yellow-500 text-white font-bold'
            : 'bg-gray-700 text-gray-300 font-mono'
        }`}
      >
        {midiWarning || midiDeviceName}
      </div>

      {/* --- Animation Area --- */}
      <div
        className="relative rounded-t-lg bg-gray-900 overflow-hidden"
        style={{ height: `${ANIMATION_AREA_HEIGHT}px` }}
      >
        {/* Song Finished Overlay */}
        {practiceMode === 'assisted' && gameState === 'finished' && (
          <div className="absolute inset-0 bg-black bg-opacity-75 flex flex-col justify-center items-center text-white z-20">
            <h2 className="text-4xl font-bold mb-4">Song Finished!</h2>
            <div className="flex gap-6 font-mono text-lg">
              <span>
                <span className="text-green-400">Hits:</span> {score.hits}
              </span>
              <span>
                <span className="text-red-400">Mistakes:</span> {score.mistakes}
              </span>
            </div>
          </div>
        )}

        {/* Falling Notes for Assisted Mode */}
        {practiceMode === 'assisted' &&
          visualSongNotes.map((note) => {
            const keyData = KEYS.find((k) => k.note === note.name);
            if (!keyData) return null;
            const color = getNoteColor(note.status, keyData.type);
            const height = note.duration * NOTE_FALL_SPEED_PPS;
            return (
              <div
                key={`assist-${note.id}`}
                className="absolute"
                style={{
                  left: `${note.left}px`,
                  width: `${note.width}px`,
                  height: `${height}px`,
                  top: 0,
                  transform: `translateY(${note.y - height}px)`,
                  opacity: note.status === 'finished' ? 0 : 1,
                  zIndex: keyData.type === 'black' ? 2 : 1,
                }}
              >
                <div
                  className={`w-full h-full rounded-md shadow-lg flex flex-col justify-start items-center p-1 ${
                    note.status === 'waiting' || note.status === 'holding'
                      ? 'animate-pulse'
                      : ''
                  }`}
                  style={{
                    opacity: 0.9,
                    border: `2px solid ${color}`,
                    boxShadow: `0 0 20px ${color}`,
                    background: `linear-gradient(180deg, ${color}, ${color}88)`,
                    transition:
                      'background 200ms ease-in-out, border-color 200ms ease-in-out, box-shadow 200ms ease-in-out',
                    textShadow: '0px 1px 3px rgba(0,0,0,0.7)',
                    lineHeight: 1.1,
                  }}
                >
                  <span className="text-white font-bold text-sm">
                    {note.name}
                  </span>
                  <span className="text-gray-200 text-xs">
                    {note.duration.toFixed(2)}s
                  </span>
                </div>
              </div>
            );
          })}

        {/* Rising Notes for Free Play Mode */}
        {practiceMode === 'free' &&
          visualSongNotes.map((note) => (
            <div
              key={`free-${note.id}`}
              ref={(el) => {
                if (el) activeFreePlayNotes.current.get(note.id).element = el;
              }}
              className="absolute bottom-0"
              style={{
                left: `${note.left}px`,
                width: `${note.width}px`,
                zIndex: note.color === '#8b5cf6' ? 2 : 1,
              }}
            >
              <div
                ref={(el) => {
                  if (el)
                    activeFreePlayNotes.current.get(note.id).visualBarElement =
                      el;
                }}
                className="absolute bottom-0 w-full rounded-md shadow-lg flex flex-col justify-start items-center p-1"
                style={{
                  height: 0,
                  opacity: 0.9,
                  border: `2px solid ${note.color}`,
                  boxShadow: `0 0 20px ${note.color}`,
                  background: `linear-gradient(180deg, ${note.color}, ${note.color}88)`,
                  textShadow: '0px 1px 3px rgba(0,0,0,0.7)',
                  lineHeight: 1.1,
                }}
              >
                {/* *** NEW: Display note name and duration for free play *** */}
                <span className="text-white font-bold text-sm">
                  {note.noteName}
                </span>
                <span
                  ref={(el) => {
                    if (el)
                      activeFreePlayNotes.current.get(note.id).durationElement =
                        el;
                  }}
                  className="text-gray-200 text-xs"
                >
                  0.00s
                </span>
              </div>
            </div>
          ))}
      </div>

      {/* --- Piano Keys --- */}
      <div className="relative flex w-full rounded-b-lg overflow-hidden mt-[-1px]">
        {/* White Keys */}
        {WHITE_KEYS.map((key) => (
          <button
            key={key.note}
            onMouseDown={() => handleNoteOn(key)}
            onMouseUp={() => handleNoteOff(key)}
            onMouseLeave={() => handleNoteOff(key)}
            className={`relative border-r border-b border-gray-400 text-gray-800 flex items-end justify-center pb-2 font-semibold transition-all duration-75 ease-in-out ${getKeyClasses(
              key
            )}`}
            style={{
              width: `${keyDimensions.whiteKeyWidth}px`,
              height: `${KEYBOARD_HEIGHT}px`,
            }}
          >
            {key.note}
          </button>
        ))}
        {/* Black Keys */}
        {BLACK_KEYS.map((key) => (
          <button
            key={key.note}
            onMouseDown={() => handleNoteOn(key)}
            onMouseUp={() => handleNoteOff(key)}
            onMouseLeave={() => handleNoteOff(key)}
            className={`absolute top-0 rounded-b-md h-40 border border-t-0 border-gray-800 text-white flex items-end justify-center pb-2 font-semibold transition-all duration-75 ease-in-out z-10 ${getKeyClasses(
              key
            )}`}
            style={{
              width: `${keyDimensions.blackKeyWidth}px`,
              left: `${
                (key.whiteKeyIndex + 1) * keyDimensions.whiteKeyWidth
              }px`,
              transform: 'translateX(-50%)',
            }}
          >
            {key.note}
          </button>
        ))}
      </div>
    </div>
  );
};

export default PianoKeyboard;
