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

# ─── Load already processed roll numbers (resume support) ─
def load_processed():
    processed = set()
    if os.path.exists(SUCCESS_FILE):
        with open(SUCCESS_FILE, "r") as f:
            reader = csv.DictReader(f)
            for row in reader:
                processed.add(row["rollno"])
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

    print(f"Resuming — {len(already_done)} already processed")

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

            rollno = row["ROLLNO"].strip()
            name   = row["STD_NAME"].strip()
            image  = row["BASE64"].strip().replace("\n", "").replace("\r", "")  # strip line breaks

            if rollno in already_done:
                print(f"[SKIP] {rollno} — already processed")
                continue

            print(f"[PROCESSING] {rollno} — {name}")

            try:
                response = session.post(
                    API_URL,
                    json={
                        "employeeNo": rollno,
                        "name": name,
                        "faceImage": image,
                    },
                    timeout=REQUEST_TIMEOUT,
                )

                data = response.json()

                if response.status_code == 200 and data.get("success"):
                    success_writer.writerow({
                        "rollno":    rollno,
                        "name":      name,
                        "timestamp": datetime.now().isoformat(),
                    })
                    sfile.flush()
                    success_count += 1
                    print(f"  ✓ SUCCESS")
                else:
                    error = data.get("error") or data.get("message") or str(data)
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
            rows_processed += 1  # only increment on actually processed rows
            time.sleep(DELAY_BETWEEN_REQUESTS)
    
    print(f"\nDone — ✓ {success_count} succeeded, ✗ {fail_count} failed")
    print(f"Check {SUCCESS_FILE} and {FAILED_FILE} for details")

if __name__ == "__main__":
    main()