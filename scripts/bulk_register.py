import csv
import time
import json
import glob
import requests
import os
from datetime import datetime
import sys
csv.field_size_limit(2**31 - 1)  # remove the field size cap

# ─── Config ───────────────────────────────────────────────
API_URL = "http://192.168.1.6:3000/students/register"
DATA_DIR = "data"
DELAY_BETWEEN_REQUESTS = 0.1  # seconds — increase if device gets overwhelmed
REQUEST_TIMEOUT = 30        # seconds per request
MAX_ROWS = None  # set to None to process all rows, per input file

SUCCESS_PREFIX = "success_"
FAILED_PREFIX = "failed_"
MISSING_FIELD_PREFIX = "Missing required field(s)"  # marks a "not a real error" row


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


# ─── Discover input CSVs (skip our own output files) ──────
def discover_input_files():
    all_csvs = sorted(glob.glob(os.path.join(DATA_DIR, "*.csv")))
    inputs = [
        f for f in all_csvs
        if not os.path.basename(f).startswith(SUCCESS_PREFIX)
        and not os.path.basename(f).startswith(FAILED_PREFIX)
    ]
    return inputs


# def output_paths_for(input_path):
#     base = os.path.basename(input_path)
#     success_path = os.path.join(DATA_DIR, f"{SUCCESS_PREFIX}{base}")
#     failed_path = os.path.join(DATA_DIR, f"{FAILED_PREFIX}{base}")
#     return success_path, failed_path

def output_paths_for(input_path):
    base = os.path.basename(input_path)
    success_dir = os.path.join(DATA_DIR, "success")
    failed_dir = os.path.join(DATA_DIR, "failed")

    # make sure folders exist
    os.makedirs(success_dir, exist_ok=True)
    os.makedirs(failed_dir, exist_ok=True)

    success_path = os.path.join(success_dir, f"{SUCCESS_PREFIX}{base}")
    failed_path = os.path.join(failed_dir, f"{FAILED_PREFIX}{base}")
    return success_path, failed_path


# ─── Load already processed roll numbers (resume support) ─
def load_processed(success_path, failed_path):
    processed = {"success": set(), "failed": set()}
    if os.path.exists(success_path):
        with open(success_path, "r") as f:
            lines = (line for line in f if not line.startswith("#"))
            reader = csv.DictReader(lines)
            for row in reader:
                processed["success"].add(row["rollno"])
    if os.path.exists(failed_path):
        with open(failed_path, "r") as f:
            lines = (line for line in f if not line.startswith("#"))
            reader = csv.DictReader(lines)
            for row in reader:
                processed["failed"].add(row["rollno"])
    return processed


# ─── Setup output files ────────────────────────────────────
def init_output_files(success_path, failed_path):
    if not os.path.exists(success_path):
        with open(success_path, "w", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=["rollno", "name", "timestamp"])
            writer.writeheader()

    if not os.path.exists(failed_path):
        with open(failed_path, "w", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=["rollno", "name", "error", "timestamp"])
            writer.writeheader()


# ─── Count "real" errors in a failed file (excludes missing-faceImage skips) ─
def count_real_errors(failed_path):
    real = 0
    total = 0
    if not os.path.exists(failed_path):
        return real, total
    with open(failed_path, "r") as f:
        lines = (line for line in f if not line.startswith("#"))
        reader = csv.DictReader(lines)
        for row in reader:
            total += 1
            if not row.get("error", "").startswith(MISSING_FIELD_PREFIX):
                real += 1
    return real, total


# ─── Prepend a stats comment line to the top of the failed file ──
def prepend_stats_line(failed_path, real_errors, total_failed):
    if not os.path.exists(failed_path):
        return
    with open(failed_path, "r") as f:
        content = f.read()
    # Strip any pre-existing stats comment line (in case of re-run) before prepending fresh one
    lines = content.splitlines(keepends=True)
    lines = [ln for ln in lines if not ln.startswith("# Real errors")]
    stats_line = f"# Real errors (excluding missing faceImage): {real_errors} / {total_failed} failed rows\n"
    with open(failed_path, "w") as f:
        f.write(stats_line)
        f.writelines(lines)


# ─── Process a single input file ──────────────────────────
def process_file(input_path, session):
    success_path, failed_path = output_paths_for(input_path)
    init_output_files(success_path, failed_path)
    already_done = load_processed(success_path, failed_path)
    already_processed_ids = already_done["success"] | already_done["failed"]

    print(f"\n=== {input_path} ===")
    print(f"Resuming — {len(already_processed_ids)} already processed "
          f"({len(already_done['success'])} success, {len(already_done['failed'])} failed)")

    success_count = 0
    fail_count = 0

    with open(input_path, "r") as infile, \
         open(success_path, "a", newline="") as sfile, \
         open(failed_path, "a", newline="") as ffile:

        reader = csv.DictReader(infile)
        success_writer = csv.DictWriter(sfile, fieldnames=["rollno", "name", "timestamp"])
        failed_writer = csv.DictWriter(ffile, fieldnames=["rollno", "name", "error", "timestamp"])

        rows_processed = 0

        for row in reader:
            if MAX_ROWS is not None and rows_processed >= MAX_ROWS:
                print(f"\n[LIMIT] Reached {MAX_ROWS} row limit — stopping")
                break

            rollno = (row.get("ID") or "").strip()
            name = (row.get("NAME") or "").strip()
            userType = (row.get("USERTYPE") or "").strip() or "normal"
            image = (row.get("BLOB_TO_BASE64") or "").strip().replace("\n", "").replace("\r", "")

            if rollno in already_processed_ids:
                print(f"[SKIP] {rollno} — already processed")
                continue

            # ── Local validation before hitting the API ──
            missing = []
            if not rollno:
                missing.append("employeeNo")
            if not name:
                missing.append("name")
            if not image:
                missing.append("faceImage")

            if missing:
                error = f"{MISSING_FIELD_PREFIX}: {', '.join(missing)} (skipped — no image/data in source row)"
                failed_writer.writerow({
                    "rollno": rollno,
                    "name": name,
                    "error": error,
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
                        "rollno": rollno,
                        "name": name,
                        "timestamp": datetime.now().isoformat(),
                    })
                    sfile.flush()
                    success_count += 1
                    print(f"  ✓ SUCCESS")
                else:
                    error = clean_error(data)
                    failed_writer.writerow({
                        "rollno": rollno,
                        "name": name,
                        "error": error,
                        "timestamp": datetime.now().isoformat(),
                    })
                    ffile.flush()
                    fail_count += 1
                    print(f"  ✗ FAILED: {error}")

            except requests.exceptions.Timeout:
                failed_writer.writerow({
                    "rollno": rollno,
                    "name": name,
                    "error": "Request timed out",
                    "timestamp": datetime.now().isoformat(),
                })
                ffile.flush()
                fail_count += 1
                print(f"  ✗ TIMEOUT")

            except Exception as e:
                failed_writer.writerow({
                    "rollno": rollno,
                    "name": name,
                    "error": str(e),
                    "timestamp": datetime.now().isoformat(),
                })
                ffile.flush()
                fail_count += 1
                print(f"  ✗ ERROR: {e}")

            rows_processed += 1
            time.sleep(DELAY_BETWEEN_REQUESTS)

    # Recompute real-error stats from the full failed file (covers resumed runs too)
    real_errors, total_failed_rows = count_real_errors(failed_path)
    prepend_stats_line(failed_path, real_errors, total_failed_rows)

    print(f"--- {input_path}: ✓ {success_count} succeeded this run, "
          f"✗ {fail_count} failed this run "
          f"(real errors so far in file: {real_errors}/{total_failed_rows}) ---")

    return {
        "input_path": input_path,
        "success_this_run": success_count,
        "fail_this_run": fail_count,
        "real_errors_total": real_errors,
        "total_failed_total": total_failed_rows,
    }


# ─── Main ──────────────────────────────────────────────────
def main():
    input_files = discover_input_files()

    if not input_files:
        print(f"No input CSV files found in '{DATA_DIR}/' "
              f"(files starting with '{SUCCESS_PREFIX}' or '{FAILED_PREFIX}' are skipped as outputs).")
        return

    print(f"Found {len(input_files)} input file(s) in '{DATA_DIR}/':")
    for f in input_files:
        print(f"  - {f}")

    session = requests.Session()
    results = [process_file(f, session) for f in input_files]

    total_success = sum(r["success_this_run"] for r in results)
    total_fail = sum(r["fail_this_run"] for r in results)
    total_real_errors = sum(r["real_errors_total"] for r in results)
    total_failed_rows = sum(r["total_failed_total"] for r in results)

    print("\n" + "=" * 60)
    print("OVERALL SUMMARY")
    print("=" * 60)
    for r in results:
        print(f"{r['input_path']}: ✓ {r['success_this_run']} this run, "
              f"✗ {r['fail_this_run']} this run | "
              f"real errors (all-time in file): {r['real_errors_total']}/{r['total_failed_total']}")
    print("-" * 60)
    print(f"TOTAL this run — ✓ {total_success} succeeded, ✗ {total_fail} failed")
    print(f"TOTAL real errors across all failed files (excluding missing faceImage): "
          f"{total_real_errors}/{total_failed_rows}")


if __name__ == "__main__":
    main()