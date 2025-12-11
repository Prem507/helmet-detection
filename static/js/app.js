// app.js - Frontend logic + Webcam + Alert System (updated: supports image/json responses, video-frame capture)
 /* Elements */
const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('fileInput');
const chooseBtn = document.getElementById('chooseBtn');
const previewImage = document.getElementById('previewImage');
const previewVideo = document.getElementById('previewVideo');
const webcamFeed = document.getElementById('webcamFeed');
const noPreview = document.getElementById('noPreview');
const detectBtn = document.getElementById('detectBtn');
const resetBtn = document.getElementById('resetBtn');
const status = document.getElementById('status');
const resultImage = document.getElementById('resultImage');
const resultText = document.getElementById('resultText');
const startCamBtn = document.getElementById('startCamBtn');
const stopCamBtn = document.getElementById('stopCamBtn');
const alertBox = document.getElementById('alertBox');
const alertSound = document.getElementById('alertSound');

let selectedFile = null;
let mediaStream = null;
let camInterval = null;
let isCamRunning = false;
const CAMERA_FPS = 1.2; // sends ~1.2 frames per second (tweak if needed)
const BACKEND_DETECT_URL = '/detect'; // relative; same host/port as frontend (served by Flask)

/* Helper - status */
function setStatus(message, isError = false) {
    status.textContent = message;
    status.style.color = isError ? 'salmon' : (message.toLowerCase().includes('done') ? 'var(--accent-blue)' : 'var(--muted-color)');
}

/* Alert popup helper */
let alertTimeout = null;
function showAlert(message, { duration = 4000, small = false, playSound = true } = {}) {
    alertBox.textContent = message;
    alertBox.classList.remove('hidden');
    alertBox.classList.toggle('small', small);
    if (playSound && alertSound) {
        try { alertSound.currentTime = 0; alertSound.play(); } catch(e){/* ignore autoplay errors */ }
    }
    // clear any existing timeout
    if (alertTimeout) clearTimeout(alertTimeout);
    alertTimeout = setTimeout(() => {
        alertBox.classList.add('hidden');
    }, duration);
}

/* Reset UI */
function resetUI() {
    resultImage.classList.add('hidden');
    resultText.textContent = 'Output will appear here.';
    setStatus('Ready');
}

/* Clear preview */
function clearPreview() {
    previewImage.classList.add('hidden');
    previewVideo.classList.add('hidden');
    webcamFeed.classList.add('hidden');
    noPreview.classList.remove('hidden');
    noPreview.textContent = 'No file selected...';
}

/* Drag & drop */
dropzone.addEventListener('click', () => fileInput.click());
chooseBtn.addEventListener('click', (e) => { e.preventDefault(); fileInput.click(); });

['dragenter','dragover'].forEach(evt => dropzone.addEventListener(evt, e => {
    e.preventDefault(); dropzone.classList.add('drag');
}));
['dragleave','drop'].forEach(evt => dropzone.addEventListener(evt, e => {
    e.preventDefault(); dropzone.classList.remove('drag');
}));

dropzone.addEventListener('drop', (e) => {
    if (e.dataTransfer.files && e.dataTransfer.files.length) {
        handleFile(e.dataTransfer.files[0]);
    }
});

fileInput.addEventListener('change', (e) => {
    if (e.target.files && e.target.files.length) handleFile(e.target.files[0]);
});

/* Handle file selection */
function handleFile(file) {
    selectedFile = file;
    resetUI();

    const type = file.type || '';
    const url = URL.createObjectURL(file);

    if (type.startsWith('image/')) {
        previewImage.src = url;
        previewImage.classList.remove('hidden');
        previewVideo.classList.add('hidden');
        webcamFeed.classList.add('hidden');
        noPreview.classList.add('hidden');
    } else if (type.startsWith('video/')) {
        previewVideo.src = url;
        // autoplay the preview so we can capture a frame later
        previewVideo.addEventListener('loadedmetadata', () => {
            previewVideo.currentTime = 0;
        }, { once: true });
        previewVideo.play().catch(()=>{}); // ignore autoplay error
        previewVideo.classList.remove('hidden');
        previewImage.classList.add('hidden');
        webcamFeed.classList.add('hidden');
        noPreview.classList.add('hidden');
    } else {
        noPreview.textContent = 'Unsupported media type.';
        selectedFile = null;
        detectBtn.disabled = true;
        resetBtn.disabled = false;
        setStatus('Unsupported', true);
        return;
    }

    detectBtn.disabled = false;
    resetBtn.disabled = false;
    setStatus('File loaded. Ready to analyze.');
}

/* Reset button */
resetBtn.addEventListener('click', () => {
    selectedFile = null;
    fileInput.value = '';
    clearPreview();
    detectBtn.disabled = true;
    resetBtn.disabled = true;
    resetUI();
    // if camera running, stop it
    if (isCamRunning) stopCamera();
});

/* Utility: capture current frame from a video element and return Blob (PNG) */
function captureFrameFromVideoElement(videoEl, desiredWidth=640, desiredHeight=480) {
    return new Promise((resolve) => {
        try {
            const w = desiredWidth;
            const h = Math.round((videoEl.videoHeight / videoEl.videoWidth) * w) || desiredHeight;
            const canvas = document.createElement('canvas');
            canvas.width = w;
            canvas.height = h;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);
            canvas.toBlob((blob) => resolve(blob), 'image/png', 0.9);
        } catch (e) {
            console.error('captureFrameFromVideoElement error', e);
            resolve(null);
        }
    });
}

/* Detection - single file/frame
   The backend might respond with:
   1) JSON: { image: "<base64 png>", detections: [...] } (preferred)
   2) image/* (blob) with response header 'helmet: true|false' (legacy)
*/
async function sendForDetectionFile(fileBlob) {
    setStatus('Processing...');
    try {
        const form = new FormData();
        form.append('file', fileBlob, 'frame.png');

        const resp = await fetch(BACKEND_DETECT_URL, {
            method: 'POST',
            body: form
        });

        if (!resp.ok) {
            const text = await resp.text();
            throw new Error(`Server ${resp.status}: ${text}`);
        }

        const contentType = (resp.headers.get('content-type') || '').toLowerCase();

        // Case A: JSON response (preferred)
        if (contentType.includes('application/json')) {
            const data = await resp.json();
            if (data.image) {
                resultImage.src = `data:image/png;base64,${data.image}`;
                resultImage.classList.remove('hidden');
                resultText.textContent = 'Analysis Complete! (Annotated)';
                setStatus('Done 🎉');
            }
            // Use detections[] if present
            handleDetectionsForAlert(data.detections || []);
            return data;
        }

        // Case B: image blob response (legacy) - check header 'helmet'
        if (contentType.startsWith('image/') || contentType.includes('png') || contentType.includes('jpeg')) {
            const blob = await resp.blob();
            const url = URL.createObjectURL(blob);
            resultImage.src = url;
            resultImage.classList.remove('hidden');
            resultText.textContent = 'Analysis Complete! (Annotated)';
            setStatus('Done 🎉');

            // Check 'helmet' header if backend provides it
            // header value should be "true" or "false"
            const helmetHeader = resp.headers.get('helmet');
            if (helmetHeader !== null) {
                const helmetFound = (helmetHeader.toLowerCase() === 'true' || helmetHeader.toLowerCase() === '1');
                if (!helmetFound) {
                    showAlert('⚠️ No helmet detected!', { duration: 5000, small: false, playSound: true });
                }
            } else {
                // no header available — we can't deduce detections, so don't alert
                // optionally, you can enable a fallback: always alert if image is returned without detections.
            }

            return { imageBlob: blob, helmetHeader: helmetHeader };
        }

        // Unknown content type
        setStatus('Unexpected response type', true);
        return null;
    } catch (err) {
        console.error(err);
        setStatus('Error: Detection failed.', true);
        resultText.textContent = 'Detection failed — check server logs.';
        return null;
    }
}

/* Main detectBtn click for selected file.
   If the selected file is a video, capture a frame from the previewVideo element.
*/
detectBtn.addEventListener('click', async () => {
    if (!selectedFile) return;
    detectBtn.disabled = true;

    try {
        if (selectedFile.type && selectedFile.type.startsWith('video/')) {
            // try to capture a frame from previewVideo
            if (previewVideo && !previewVideo.classList.contains('hidden')) {
                // ensure video has current frame (paused or playing)
                const blob = await captureFrameFromVideoElement(previewVideo, 640, 480);
                if (blob) {
                    await sendForDetectionFile(blob);
                } else {
                    // fallback: send full video file (may or may not be supported by backend)
                    await sendForDetectionFile(selectedFile);
                }
            } else {
                // fallback: send full video file
                await sendForDetectionFile(selectedFile);
            }
        } else {
            // image or other - send directly
            await sendForDetectionFile(selectedFile);
        }
    } finally {
        detectBtn.disabled = false;
    }
});

/* Detection decision logic for alerts
   This is heuristic: adapt to your model class names.
   We'll trigger alert if we detect explicit "no_helmet" or "without" labels,
   or we detect 'person' without helmet label nearby.
*/
function handleDetectionsForAlert(detections = []) {
    if (!Array.isArray(detections)) return;

    // If nothing detected → notify (optional)
    if (detections.length === 0) {
        // no detections -> don't alarm by default
        return;
    }

    // Normalize labels
    const labels = detections.map(d => (d.label || '').toString().toLowerCase());
    // If any label indicates violation
    const violationKeywords = ['no_helmet', 'without', 'nohelmet', 'violation', 'unhelmeted', 'no-helmet', 'no helmet', 'without helmet', 'person_without_helmet', 'helmet_missing', 'helmet_off'];
    const hasViolation = labels.some(l => violationKeywords.some(k => l.includes(k)));

    // Also if there are "person" instances but no "helmet" instances, consider as possible violation
    const hasPerson = labels.some(l => l.includes('person'));
    const hasHelmet = labels.some(l => l.includes('helmet') && !l.includes('no') && !l.includes('missing'));

    if (hasViolation) {
        showAlert('⚠️ Violation detected: No helmet!', { duration: 5000, small: false, playSound: true });
    } else if (hasPerson && !hasHelmet) {
        showAlert('⚠️ Person(s) without helmet detected!', { duration: 5000, small: false, playSound: true });
    } else {
        // optionally show 'all clear' - commented out by default
        // showAlert('All clear ✅', { duration: 2000, small: true, playSound: false });
    }
}

/* ---------- Webcam logic ---------- */
async function startCamera() {
    if (isCamRunning) return;
    try {
        mediaStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
        webcamFeed.srcObject = mediaStream;
        webcamFeed.classList.remove('hidden');
        previewImage.classList.add('hidden');
        previewVideo.classList.add('hidden');
        noPreview.classList.add('hidden');

        isCamRunning = true;
        startCamBtn.disabled = true;
        stopCamBtn.disabled = false;
        setStatus('Camera running. Capturing frames...');

        // create hidden canvas for captures
        const videoTrack = mediaStream.getVideoTracks()[0];
        const settings = videoTrack.getSettings();
        const width = settings.width || 640;
        const height = settings.height || 480;

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');

        // capture loop
        camInterval = setInterval(async () => {
            try {
                // draw current frame
                ctx.drawImage(webcamFeed, 0, 0, canvas.width, canvas.height);
                // convert to blob (PNG)
                const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png', 0.9));
                if (!blob) return;
                // send to backend
                await sendForDetectionFile(blob);
            } catch (err) {
                console.error('camera capture error', err);
            }
        }, 1000 / CAMERA_FPS);
    } catch (err) {
        console.error('Could not start camera', err);
        setStatus('Camera access denied or not available', true);
        showAlert('Camera access denied or not available.', { duration: 3500, playSound: false });
    }
}

function stopCamera() {
    if (!isCamRunning) return;
    // stop interval
    if (camInterval) {
        clearInterval(camInterval);
        camInterval = null;
    }
    // stop tracks
    if (mediaStream) {
        mediaStream.getTracks().forEach(t => t.stop());
        mediaStream = null;
    }
    webcamFeed.srcObject = null;
    webcamFeed.classList.add('hidden');
    isCamRunning = false;
    startCamBtn.disabled = false;
    stopCamBtn.disabled = true;
    setStatus('Camera stopped');
}

/* Start/Stop button events */
startCamBtn.addEventListener('click', () => startCamera());
stopCamBtn.addEventListener('click', () => stopCamera());

/* Cleanup if user leaves or reloads page */
window.addEventListener('beforeunload', () => {
    if (isCamRunning) stopCamera();
});
