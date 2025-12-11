from flask import Flask, request, jsonify, render_template
from flask_cors import CORS
import os
import io
import base64
import numpy as np
import cv2
from ultralytics import YOLO
import logging

app = Flask(__name__, static_folder='static', template_folder='templates')
CORS(app, resources={r"/*": {"origins": "*"}})

# Load YOLO model
MODEL_PATH = os.path.join(os.path.dirname(__file__), "best.pt")
print("Loading YOLO model from:", MODEL_PATH)
try:
    model = YOLO(MODEL_PATH)
    print("Model loaded.")
except Exception as e:
    print("Failed to load model:", e)
    model = None

@app.route('/')
def home():
    return render_template('index.html')

@app.route('/health', methods=['GET'])
def health():
    return jsonify({"status": "ok", "model_loaded": model is not None})

@app.route('/detect', methods=['POST'])
def detect():
    if model is None:
        return "Model not loaded", 500

    if 'file' not in request.files:
        return "No file part", 400

    f = request.files['file']
    if f.filename == '':
        return "No selected file", 400

    data = f.read()
    nparr = np.frombuffer(data, np.uint8)
    img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
    if img is None:
        return "Could not decode image", 400

    try:
        # predict; using device cpu by default; set device='0' for GPU if available
        results = model.predict(source=img, imgsz=640, device='cpu')
    except Exception as e:
        app.logger.exception("Model prediction error")
        return f"Model error: {e}", 500

    if not results:
        return "No results", 500

    res = results[0]

    # annotated image as BGR numpy array
    try:
        annotated = res.plot()  # returns annotated image (BGR numpy)
    except Exception as e:
        app.logger.exception("Annotation error")
        annotated = img  # fallback to original

    # extract detection info
    detections = []
    try:
        # res.boxes data structure: .cls or .names may vary by version
        # iterate boxes if present
        boxes = getattr(res, 'boxes', None)
        # model names from model.names if available
        names = {}
        try:
            names = model.names if hasattr(model, 'names') else {}
        except Exception:
            names = {}

        if boxes is not None:
            # boxes.cls and boxes.conf might be tensors; convert to list
            try:
                cls_arr = boxes.cls.cpu().numpy() if hasattr(boxes, 'cls') else None
            except Exception:
                cls_arr = None
            try:
                conf_arr = boxes.conf.cpu().numpy() if hasattr(boxes, 'conf') else None
            except Exception:
                conf_arr = None

            # if boxes.xyxy exists, iterate by length
            n_boxes = 0
            try:
                n_boxes = len(boxes)
            except Exception:
                # fallback: try cls array length
                if cls_arr is not None:
                    n_boxes = len(cls_arr)
            if n_boxes == 0 and cls_arr is not None:
                n_boxes = len(cls_arr)

            for i in range(n_boxes):
                lab = ''
                confv = None
                try:
                    if cls_arr is not None:
                        idx = int(cls_arr[i])
                        lab = str(names.get(idx, str(idx)))
                    if conf_arr is not None:
                        confv = float(conf_arr[i])
                except Exception:
                    lab = ''
                    confv = None
                detections.append({"label": lab, "conf": confv})
    except Exception:
        app.logger.exception("Error extracting detections")

    # encode annotated image to PNG and base64
    try:
        is_success, buffer = cv2.imencode(".png", annotated)
        if not is_success:
            return "Encoding error", 500
        b64 = base64.b64encode(buffer.tobytes()).decode('utf-8')
    except Exception:
        app.logger.exception("Image encoding error")
        return "Encoding error", 500

    response_payload = {
        "image": b64,
        "detections": detections
    }
    return jsonify(response_payload)

if __name__ == '__main__':
    # ensure debug only in dev
    app.run(host='0.0.0.0', port=5000, debug=True)
