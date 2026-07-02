import csv
import time
import json
import requests
import os
from datetime import datetime
import sys
csv.field_size_limit(sys.maxsize)  # remove the field size cap

# ─── Config ───────────────────────────────────────────────
API_URL = "http://192.168.12.128:3000/students/register"
INPUT_FILE = "data/students.csv"
SUCCESS_FILE = "data/success.csv"
FAILED_FILE = "data/failed.csv"
DELAY_BETWEEN_REQUESTS = 0.2  # seconds — increase if device gets overwhelmed
REQUEST_TIMEOUT = 30        # seconds per request
MAX_ROWS = None  # set to None to process all rows


# ─── Helper: turn any error shape into a short, readable string ──
def clean_error(data):
    """
    Extracts a short, human-readable error message from whatever shape
    the API gave back. Handles:
      - plain string errors: "employeeNo, name and faceImage are required"
      - nested dict/JSON error blobs with 'results' -> 'error' -> JSON string
      - generic dict/message fallbacks
    """
    if data is None:
        return "Unknown error (empty response)"

    # Case 1: API gave a plain string error
    if isinstance(data, str):
        return data.strip()

    if not isinstance(data, dict):
        return str(data)

    # Case 2: top-level "error" or "message" is already a plain string
    top_error = data.get("error") or data.get("message")
    if isinstance(top_error, str) and not top_error.strip().startswith("{"):
        return top_error.strip()

    # Case 3: the Hikvision-style nested summary/results blob
    results = data.get("results")
    if isinstance(results, list) and results:
        first = results[0]
        err = first.get("error")
        if err:
            # err is often itself a JSON string like:
            # '{"statusCode":6,"statusString":"Invalid Content",
            #   "subStatusCode":"SubpicAnalysisModelingError",
            #   "errorCode":1610612791,"errorMsg":"PicFeaturePoints"}'
            try:
                err_obj = json.loads(err) if isinstance(err, str) else err
                status_string = err_obj.get("statusString", "")
                sub_status = err_obj.get("subStatusCode", "")
                msg = err_obj.get("errorMsg", "")
                parts = [p for p in [status_string, sub_status, msg] if p]
                return " / ".join(parts) if parts else str(err_obj)
            except (json.JSONDecodeError, TypeError):
                return str(err)

        # device-level failure but no "error" key — fall back to status text
        device_data = first.get("data", {})
        if isinstance(device_data, dict):
            inner = device_data.get("data", {})
            status_string = inner.get("statusString")
            if status_string and status_string.lower() != "ok":
                return status_string

    # Case 4: nothing matched, fall back to a compact JSON dump
    if isinstance(top_error, str):
        return top_error.strip()
    return json.dumps(data)[:200]


# ─── Load already processed roll numbers (resume support) ─
def load_processed():
    processed = {"success": set(), "failed": set()}
    if os.path.exists(SUCCESS_FILE):
        with open(SUCCESS_FILE, "r") as f:
            reader = csv.DictReader(f)
            for row in reader:
                processed["success"].add(row["rollno"])
    if os.path.exists(FAILED_FILE):
        with open(FAILED_FILE, "r") as f:
            reader = csv.DictReader(f)
            for row in reader:
                processed["failed"].add(row["rollno"])
    return processed


# ─── Setup output files ────────────────────────────────────
def init_output_files():
    if not os.path.exists(SUCCESS_FILE):
        with open(SUCCESS_FILE, "w", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=["rollno", "name", "timestamp"])
            writer.writeheader()

    if not os.path.exists(FAILED_FILE):
        with open(FAILED_FILE, "w", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=["rollno", "name", "error", "timestamp"])
            writer.writeheader()


# ─── Main ──────────────────────────────────────────────────
def main():
    init_output_files()
    already_done = load_processed()
    already_processed_ids = already_done["success"] | already_done["failed"]

    print(f"Resuming — {len(already_processed_ids)} already processed "
          f"({len(already_done['success'])} success, {len(already_done['failed'])} failed)")

    session = requests.Session()

    success_count = 0
    fail_count = 0

    with open(INPUT_FILE, "r") as infile, \
         open(SUCCESS_FILE, "a", newline="") as sfile, \
         open(FAILED_FILE, "a", newline="") as ffile:

        reader = csv.DictReader(infile)
        success_writer = csv.DictWriter(sfile, fieldnames=["rollno", "name", "timestamp"])
        failed_writer  = csv.DictWriter(ffile, fieldnames=["rollno", "name", "error", "timestamp"])

        rows_processed = 0

        for row in reader:
            if MAX_ROWS is not None and rows_processed >= MAX_ROWS:
                print(f"\n[LIMIT] Reached {MAX_ROWS} row limit — stopping")
                break

            rollno  = (row.get("ROLLNO") or "").strip()
            name    = (row.get("STD_NAME") or "").strip()
            userType = (row.get("USERTYPE") or "").strip() or "normal"
            image   = (row.get("BASE64") or "").strip().replace("\n", "").replace("\r", "")

            if rollno in already_processed_ids:
                print(f"[SKIP] {rollno} — already processed")
                continue

            # ── Local validation before hitting the API ──
            # Catches the rows that were silently failing with
            # "employeeNo, name and faceImage are required"
            missing = []
            if not rollno:
                missing.append("employeeNo")
            if not name:
                missing.append("name")
            if not image:
                missing.append("faceImage")

            if missing:
                error = f"Missing required field(s): {', '.join(missing)} (skipped — no image/data in source row)"
                failed_writer.writerow({
                    "rollno":    rollno,
                    "name":      name,
                    "error":     error,
                    "timestamp": datetime.now().isoformat(),
                })
                ffile.flush()
                fail_count += 1
                rows_processed += 1
                print(f"[PROCESSING] {rollno or '(no id)'} — {name or '(no name)'}")
                print(f"  ✗ FAILED (local check): {error}")
                continue

            print(f"[PROCESSING] {rollno} — {name}")

            try:
                response = session.post(
                    API_URL,
                    json={
                        "employeeNo": rollno,
                        "name": name,
                        "faceImage": image,
                        "userType": userType,
                    },
                    timeout=REQUEST_TIMEOUT,
                )

                try:
                    data = response.json()
                except ValueError:
                    data = response.text

                # Determine success robustly:
                # - HTTP 200 AND
                # - top-level success flag (if present) is truthy, OR
                #   nested summary shows succeeded >= 1 and failed == 0
                is_success = False
                if response.status_code == 200 and isinstance(data, dict):
                    if data.get("success") is True:
                        is_success = True
                    else:
                        summary = data.get("summary")
                        if isinstance(summary, dict):
                            is_success = summary.get("failed", 1) == 0 and summary.get("succeeded", 0) > 0

                if is_success:
                    success_writer.writerow({
                        "rollno":    rollno,
                        "name":      name,
                        "timestamp": datetime.now().isoformat(),
                    })
                    sfile.flush()
                    success_count += 1
                    print(f"  ✓ SUCCESS")
                else:
                    error = clean_error(data)
                    failed_writer.writerow({
                        "rollno":    rollno,
                        "name":      name,
                        "error":     error,
                        "timestamp": datetime.now().isoformat(),
                    })
                    ffile.flush()
                    fail_count += 1
                    print(f"  ✗ FAILED: {error}")

            except requests.exceptions.Timeout:
                failed_writer.writerow({
                    "rollno":    rollno,
                    "name":      name,
                    "error":     "Request timed out",
                    "timestamp": datetime.now().isoformat(),
                })
                ffile.flush()
                fail_count += 1
                print(f"  ✗ TIMEOUT")

            except Exception as e:
                failed_writer.writerow({
                    "rollno":    rollno,
                    "name":      name,
                    "error":     str(e),
                    "timestamp": datetime.now().isoformat(),
                })
                ffile.flush()
                fail_count += 1
                print(f"  ✗ ERROR: {e}")

            rows_processed += 1
            time.sleep(DELAY_BETWEEN_REQUESTS)

    print(f"\nDone — ✓ {success_count} succeeded, ✗ {fail_count} failed")
    print(f"Check {SUCCESS_FILE} and {FAILED_FILE} for details")


if __name__ == "__main__":
    main()