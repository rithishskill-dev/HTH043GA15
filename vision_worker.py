"""Read one RTSP stream and emit YOLO person counts as JSON lines.

Install requirements.txt before running this worker. The Node server supervises it.
"""
import argparse
import json
import os
import sys
import time


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--camera-id', required=True)
    parser.add_argument('--url', required=True)
    parser.add_argument('--model', default=os.getenv('YOLO_MODEL', 'yolo11n.pt'))
    parser.add_argument('--area', default='Unassigned area')
    args = parser.parse_args()

    try:
        import cv2
        from ultralytics import YOLO
    except ImportError as error:
        print(json.dumps({'cameraId': args.camera_id, 'status': 'vision_unavailable', 'error': str(error)}), flush=True)
        return 2

    model = YOLO(args.model)
    capture = cv2.VideoCapture(args.url)
    if not capture.isOpened():
        print(json.dumps({'cameraId': args.camera_id, 'status': 'offline', 'error': 'Could not open RTSP stream'}), flush=True)
        return 3

    last_emit = 0.0
    while True:
        ok, frame = capture.read()
        if not ok:
            print(json.dumps({'cameraId': args.camera_id, 'status': 'offline', 'error': 'Lost RTSP frame'}), flush=True)
            time.sleep(2)
            continue
        now = time.time()
        if now - last_emit < 1:
            continue
        last_emit = now
        result = model(frame, classes=[0], verbose=False)[0]
        count = len(result.boxes)
        height, width = frame.shape[:2]
        # A calibrated zone area should replace this estimate for production events.
        density = round(count / max((width * height) / 100000, 1), 2)
        print(json.dumps({'cameraId': args.camera_id, 'area': args.area, 'status': 'online', 'people': count, 'density': density, 'timestamp': time.time()}), flush=True)


if __name__ == '__main__':
    sys.exit(main())
