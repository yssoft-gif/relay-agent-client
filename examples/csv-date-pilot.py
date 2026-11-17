#!/usr/bin/env python3
"""RELAY synthetic CSV acceptance sample, not a customer job or offered service.

Python 3.11+, standard library only. No network, wallet, payments, or private data.
  python csv-date-pilot.py --demo-dir NEW_DIRECTORY
  python csv-date-pilot.py --check-dir NEW_DIRECTORY
  python csv-date-pilot.py --self-test

The checker accepts only this exact synthetic fixture; it is not a general CSV
cleaner or evidence of execution, customer acceptance, quality, or payment.
For a real job, parties must agree inputs, rules, deliverables, price, deadline,
and acceptance separately. No seller availability or price is promised.
"""
import argparse
import csv
import io
import json
from pathlib import Path
import tempfile

HEADER = ['id', 'date', 'note']
INPUT = [
 ['1', '2026/11/01', 'comma, preserved'],
 ['2', '2026-11-02', 'already ISO'],
 ['3', '03/04/2026', 'ambiguous month/day'],
 ['4', '2026-02-30', 'invalid date'],
 ['5', '', 'empty stays empty'],
 ['6', '2024/02/29', 'leap day'],
 ['7', '2026-11-07', 'embedded "quote"'],
 ['8', '2026/11/08', 'embedded\nnewline'],
 ['9', 'tomorrow', 'unsupported relative date'],
 ['10', '2026-11-10T09:00:00+09:00', 'timestamp out of scope'],
]
# Independently written expectations; no conversion algorithm is used to approve.
EXPECTED = [
 ['1', '2026-11-01', 'comma, preserved'],
 ['2', '2026-11-02', 'already ISO'],
 ['3', '03/04/2026', 'ambiguous month/day'],
 ['4', '2026-02-30', 'invalid date'],
 ['5', '', 'empty stays empty'],
 ['6', '2024-02-29', 'leap day'],
 ['7', '2026-11-07', 'embedded "quote"'],
 ['8', '2026-11-08', 'embedded\nnewline'],
 ['9', 'tomorrow', 'unsupported relative date'],
 ['10', '2026-11-10T09:00:00+09:00', 'timestamp out of scope'],
]
CHANGES = [
 {'row_id':'1','column':'date','before':'2026/11/01','after':'2026-11-01','reason':'agreed_yyyy_mm_dd_separator'},
 {'row_id':'6','column':'date','before':'2024/02/29','after':'2024-02-29','reason':'agreed_yyyy_mm_dd_separator'},
 {'row_id':'8','column':'date','before':'2026/11/08','after':'2026-11-08','reason':'agreed_yyyy_mm_dd_separator'},
]
UNRESOLVED = [
 {'row_id':'3','column':'date','value':'03/04/2026','reason':'ambiguous_month_day'},
 {'row_id':'4','column':'date','value':'2026-02-30','reason':'invalid_calendar_date'},
 {'row_id':'9','column':'date','value':'tomorrow','reason':'relative_date_not_allowed'},
 {'row_id':'10','column':'date','value':'2026-11-10T09:00:00+09:00','reason':'timestamp_not_in_scope'},
]
REPORT = {'schema':'relay-synthetic-csv-sample/1','synthetic':True,
 'input_rows':10,'output_rows':10,'changed_cells':3,'unresolved_cells':4,
 'customer_job':False,'accepted_agreement':False,'payment_verified':False}
RULES = '''Synthetic acceptance sample only. No real customer records.
Agreed scope: one date column, ten data rows. Normalize only year/month/day
with slash separators to YYYY-MM-DD. Keep valid ISO dates and empty cells.
Do not infer locale, missing dates, relative dates, timestamps, or timezone.
Preserve header, row order/count, identifiers and every non-date cell.
Report every changed cell and every ambiguous, invalid or out-of-scope value.
CSV quoting, commas and embedded newlines must survive a CSV parser round trip.
input.csv and output.csv are synthetic samples, not conversion of user data.
check compares exact independent fixture expectations and complete logs.
A passing sample is not a delivery, customer acceptance, or mainnet receipt.
'''

def csv_text(rows):
    stream = io.StringIO(newline='')
    writer = csv.writer(stream, lineterminator='\n')
    writer.writerows([HEADER] + rows)
    return stream.getvalue()

def json_text(value):
    return json.dumps(value, ensure_ascii=False, indent=2) + '\n'

FILES = {'input.csv':csv_text(INPUT),'output.csv':csv_text(EXPECTED),
 'changes.json':json_text(CHANGES),'unresolved.json':json_text(UNRESOLVED),
 'report.json':json_text(REPORT),'RULES.txt':RULES}

def generate(directory):
    # Require a new directory: never overwrite existing work.
    directory.mkdir(parents=False, exist_ok=False)
    for name, value in FILES.items():
        with (directory/name).open('x', encoding='utf-8', newline='') as f:
            f.write(value)

def check(directory):
    for name, expected in FILES.items():
        path = directory/name
        if path.is_symlink() or not path.is_file() or path.stat().st_size > 1024*1024:
            raise ValueError('missing, symlink or oversized sample file')
        actual = path.read_text(encoding='utf-8')
        # Exact text deliberately rejects duplicate JSON keys, bool/int coercion,
        # trailing records, changed quoting or undeclared changes in this fixture.
        if actual != expected:
            raise ValueError('sample differs from agreed fixture')
    return True

def self_test():
    checked = 0
    mutations = [
      ('output.csv', lambda s:s.replace('comma, preserved','edited note')),
      ('output.csv', lambda s:s.replace('3,03/04/2026','3,2026-03-04')),
      ('output.csv', lambda s:s.replace('2,2026-11-02,already ISO\n','')),
      ('output.csv', lambda s:s.replace('1,2026-11-01','99,2026-11-01')),
      ('changes.json', lambda s:'[]\n'),
      ('unresolved.json', lambda s:'[]\n'),
      ('report.json', lambda s:s.replace('"payment_verified": false','"payment_verified": true')),
      ('input.csv', lambda s:s.replace('tomorrow','today')),
    ]
    with tempfile.TemporaryDirectory() as temp:
        base = Path(temp)/'sample'; generate(base); check(base); checked += 1
        for name, mutate in mutations:
            (base/name).write_text(mutate(FILES[name]),encoding='utf-8',newline='')
            try: check(base)
            except ValueError: checked += 1
            else: raise AssertionError('mutation was accepted')
            (base/name).write_text(FILES[name],encoding='utf-8',newline='')
        rows = list(csv.reader(io.StringIO(FILES['output.csv'],newline='')))
        assert rows == [HEADER] + EXPECTED
        assert len(rows) == 11 and rows[8][2] == 'embedded\nnewline'
        checked += 1
    print(json.dumps({'ok':True,'checks':checked,'synthetic':True,'funds_sent':False}))

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument('--demo-dir',type=Path)
    group.add_argument('--check-dir',type=Path)
    group.add_argument('--self-test',action='store_true')
    args = parser.parse_args()
    try:
        if args.self_test: self_test()
        elif args.demo_dir:
            generate(args.demo_dir);check(args.demo_dir)
            print('Created and checked synthetic sample; no customer work or payment.')
        else:
            check(args.check_dir);print('PASS: exact synthetic acceptance fixture only.')
    except (OSError, ValueError, UnicodeError):
        parser.exit(1,'FAIL: sample unavailable or differs; no private contents printed.\n')

if __name__ == '__main__': main()
