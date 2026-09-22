"""Public benchmark adapters. Ratings and publisher claims never become role scores."""
from collections import defaultdict
from datetime import datetime, timezone
import json
import math
from pathlib import Path
import re

LCB_URL = 'https://livecodebench.github.io/performances_generation.json'
ARENA_URL = 'https://arena.ai/leaderboard/text'


def finite(value, lower=0, upper=100):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and lower <= value <= upper


def next_payloads(html):
    parts = []
    for raw in re.findall(r'self\.__next_f\.push\((\[1,.*?\])\)</script>', html, re.S):
        try:
            parts.append(json.loads(raw)[1])
        except (ValueError, IndexError):
            continue
    for line in ''.join(parts).splitlines():
        try:
            yield json.loads(line.split(':', 1)[1])
        except (ValueError, IndexError):
            continue


def walk(value):
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from walk(child)
    elif isinstance(value, list):
        for child in value:
            yield from walk(child)


def tested_name(value):
    """Only an explicitly labelled effort is removable; version/quantization stays."""
    match = re.search(r'(?:[-_]|\s*\()(xhigh|high|medium|low|max)(?:\))?$', value, re.I)
    return (value[:match.start()], match[1].lower()) if match else (value, '')


def arena_data(html):
    boards = [v for payload in next_payloads(html) for v in walk(payload)
              if v.get('arenaSlug') == 'text' and v.get('leaderboardSlug') == 'overall'
              and isinstance(v.get('entries'), list) and v.get('params', {}).get('styleControl') is True]
    if len(boards) != 1:
        raise ValueError('Arena public schema changed')
    board = boards[0]
    date = datetime.fromisoformat(board['voteCutoffISOString'].replace('Z', '+00:00')).date().isoformat()
    records = []
    for row in board['entries']:
        if not isinstance(row.get('modelDisplayName'), str) or not finite(row.get('rating'), 0, 5000):
            continue
        if not finite(row.get('votes'), 1, 1e9):
            continue
        name, effort = tested_name(row['modelDisplayName'])
        record = {'id': row['modelDisplayName'], 'baseId': name, 'effort': effort,
                  'source': 'Arena', 'kind': 'preference', 'release': date, 'dateKind': 'Голоси до',
                  'scores': {}, 'rating': round(row['rating']), 'votes': row['votes'],
                  'url': ARENA_URL, 'dataUrl': ARENA_URL,
                  'note': 'Text · Overall · Style Control. Рейтинг людських уподобань, не відсоток виконаних задач.'}
        lo, hi = row.get('ratingLower'), row.get('ratingUpper')
        if finite(lo, 0, 5000) and finite(hi, 0, 5000) and lo <= row['rating'] <= hi:
            record['interval'] = [round(lo), round(hi)]
        if row.get('releaseType'):
            record['preliminary'] = True
        records.append(record)
    if not records:
        raise ValueError('No Arena entries')
    return records


def livecode_identity(model):
    name = model['model_name']
    # These API aliases have changed since the measured run. Bind the old result
    # to the release printed by the benchmark, never today's rolling alias.
    if name in ('deepseek-chat', 'deepseek-reasoner'):
        return model['model_repr'], ''
    if '__' in name:
        return tested_name(name.replace('__', '_'))
    if name == 'grok-3-mini-beta_high':
        return 'grok-3-mini-beta', 'high'
    if name.endswith('_nothink'):
        return name.removesuffix('_nothink'), 'non-thinking'
    return name, 'thinking' if '(Thinking)' in model['model_repr'] else ''


def livecode_data(data):
    dates = sorted(set(d for d in data['date_marks'] if finite(d, 1e12, 1e14)))
    if len(dates) < 5:
        raise ValueError('No LiveCodeBench date range')
    # Same default date window as the official leaderboard; never imply today's run.
    start, end = dates[15 if len(dates) > 15 else 4], dates[-1]
    day = lambda n: datetime.fromtimestamp(n / 1000, timezone.utc).date().isoformat()
    groups = defaultdict(list)
    for row in data['performances']:
        if (isinstance(row.get('model'), str) and finite(row.get('date'), start, end)
                and finite(row.get('pass@1'))):
            groups[row['model']].append(row)
    records = []
    for model in data['models']:
        rows = groups.get(model.get('model_repr'))
        if not rows or not isinstance(model.get('model_name'), str):
            continue
        scores = {'Pass@1': round(sum(r['pass@1'] for r in rows) / len(rows), 2)}
        for difficulty in ('easy', 'medium', 'hard'):
            values = [r['pass@1'] for r in rows if r.get('difficulty') == difficulty]
            if values:
                scores[difficulty.title()] = round(sum(values) / len(values), 2)
        base, effort = livecode_identity(model)
        records.append({'id': model['model_repr'], 'baseId': base, 'effort': effort,
                        'source': 'LiveCodeBench', 'kind': 'benchmark', 'scores': scores,
                        'release': day(start) + ' — ' + day(end), 'dateKind': 'Задачі за',
                        'samples': len(rows), 'potentialOverlap': model.get('release_date', end) >= start,
                        'url': 'https://livecodebench.github.io/leaderboard.html', 'dataUrl': LCB_URL,
                        'note': 'Генерація коду · середній Pass@1 у публічному часовому зрізі. Це не тест роботи в OMP.'})
    if not records:
        raise ValueError('No LiveCodeBench results')
    return records


def developer_data():
    records = json.loads((Path(__file__).parent / 'developer-benchmarks.json').read_text())
    for record in records:
        if record.get('kind') != 'developer' or not record.get('url', '').startswith('https://huggingface.co/'):
            raise ValueError('Publisher evidence requires provenance')
        if not record.get('scores') or not all(finite(v) for v in record['scores'].values()):
            raise ValueError('Invalid publisher percentage')
    return records
