"""Deterministic (zero-LLM) parsing + normalization of businesses, addresses, agencies."""

from __future__ import annotations

import html
import re
import uuid

NS = uuid.UUID('6c0b6b6e-cb06-4c0b-9b6e-000000000c06')
GROUP_ID = 'cb6'


def uid(*parts: str) -> str:
    return str(uuid.uuid5(NS, '|'.join(parts)))


# ---------------------------------------------------------------- addresses
ORDINAL_WORDS = {
    'first': '1st', 'second': '2nd', 'third': '3rd', 'fourth': '4th', 'fifth': '5th',
    'sixth': '6th', 'seventh': '7th', 'eighth': '8th', 'ninth': '9th', 'tenth': '10th',
    'eleventh': '11th', 'twelfth': '12th',
}
SUFFIXES = {
    'avenue': 'Avenue', 'ave': 'Avenue', 'av': 'Avenue', 'street': 'Street', 'st': 'Street',
    'place': 'Place', 'pl': 'Place', 'road': 'Road', 'rd': 'Road', 'drive': 'Drive', 'dr': 'Drive',
    'plaza': 'Plaza', 'oval': 'Oval', 'square': 'Square', 'sq': 'Square', 'boulevard': 'Boulevard',
    'blvd': 'Boulevard', 'lane': 'Lane', 'terrace': 'Terrace', 'loop': 'Loop',
}
_ORD = r'(?i:\d{1,3}(?:st|nd|rd|th)?|' + '|'.join(ORDINAL_WORDS) + ')'
_NAMEWORD = r"(?:[A-Z][a-zA-Z'\.]+)"
_SUFFIX = r'(?i:' + '|'.join(sorted(SUFFIXES, key=len, reverse=True)) + r')\b\.?'
_DIR = r'(?:East|West|E|W)\.?'
# house number (optionally a range) + optional direction + street name + suffix (+ optional South/North)
ADDR_RE = re.compile(
    r'(?<!CB )(?<!CB)(?<!Board )(?<!District )\b(?P<num>\d{1,5}[A-Za-z]?(?:\s*[-–]\s*\d{1,5}[A-Za-z]?)?)\s+'
    r'(?P<street>(?:' + _DIR + r'\s+)?(?:' + _ORD + r'|' + _NAMEWORD + r'(?:\s+' + _NAMEWORD + r'){0,2})\s+'
    + _SUFFIX + r'(?:\s+(?:South|North))?)',
)
ADDR_RE_I = re.compile(ADDR_RE.pattern, re.IGNORECASE)
_BAD_STREET_WORDS = {'floor', 'fl', 'year', 'years', 'seats', 'tables', 'units', 'people'}


def normalize_street(street: str) -> str | None:
    toks = re.sub(r'[.,]', ' ', street).split()
    out: list[str] = []
    for i, t in enumerate(toks):
        low = t.lower()
        last = i == len(toks) - 1 or (i == len(toks) - 2 and toks[-1].lower() in ('south', 'north'))
        if low in _BAD_STREET_WORDS:
            return None
        if i == 0 and low in ('e', 'east'):
            out.append('East')
        elif i == 0 and low in ('w', 'west'):
            out.append('West')
        elif low in ORDINAL_WORDS:
            out.append(ORDINAL_WORDS[low])
        elif re.fullmatch(r'\d{1,3}', low):
            n = int(low)
            suf = 'th' if 10 <= n % 100 <= 20 else {1: 'st', 2: 'nd', 3: 'rd'}.get(n % 10, 'th')
            out.append(f'{n}{suf}')
        elif re.fullmatch(r'\d{1,3}(st|nd|rd|th)', low):
            out.append(low)
        elif last and low in SUFFIXES:
            out.append(SUFFIXES[low])
        elif low in ('south', 'north'):
            out.append(low.title())
        else:
            out.append(t[:1].upper() + t[1:].lower())
    if not out or out[-1] not in SUFFIXES.values() and out[-1] not in ('South', 'North'):
        return None
    return ' '.join(out)


def parse_addresses(text: str | None, ignore_case: bool = False) -> list[tuple[str, str]]:
    """Return [(canonical_key, raw)] e.g. ('310 2nd Avenue', '310 Second Ave')."""
    if not text:
        return []
    text = html.unescape(text)
    res = []
    for m in (ADDR_RE_I if ignore_case else ADDR_RE).finditer(text):
        num = re.split(r'\s*[-–]\s*', m.group('num'))[0].upper()
        street = normalize_street(m.group('street'))
        if not street:
            continue
        key = f'{num} {street}'
        if key not in [k for k, _ in res]:
            res.append((key, m.group(0)))
    return res


def normalize_address(text: str | None) -> str | None:
    found = parse_addresses(text, ignore_case=True)
    return found[0][0] if found else None


# ---------------------------------------------------------------- businesses
_CORP = r'\b(?:inc|incorporated|llc|l\.l\.c|corp|corporation|co|ltd|lp|llp|pllc)\b\.?'
_NULL_DBA = {'tbd', 'n/a', 'na', 'none', 'tba', 'to be determined', ''}
DBA_RE = re.compile(
    r'\bfor\s+(?:the\s+)?(?P<legal>(?:(?!\bfor\s)[^;:]){2,120}?),?\s+(?:d/b/a|d\.b\.a\.?|dba|doing business as)\s+'
    r'(?P<dba>.+?)(?=\s+(?:at|located at|on|in)\s+\d|\s*,\s*\d|\s*\(|\s*$|\s+for\s|;|\.\s)',
    re.IGNORECASE,
)
DBA_LOOSE_RE = re.compile(
    r'(?P<legal>[A-Z0-9](?:(?!\bfor\s)[^;:,]){1,80}?),?\s+(?:d/b/a|d\.b\.a\.?|dba|doing business as)\s+'
    r'(?P<dba>.+?)(?=\s+(?:at|located at|on|in)\s+\d|\s*,\s*\d|\s*\(|\s*$|;|\.\s)',
    re.IGNORECASE,
)
FOR_AT_RE = re.compile(r'\b(?:license|permit|application|cafe|café)\s+for\s+(?P<name>(?:(?!\bfor\s)[^;:]){2,100}?)\s+at\s+\d', re.IGNORECASE)
AT_COMMA_RE = re.compile(r'\b(?:for|at)\s+(?P<name>[A-Z][^;:,]{1,60}?),\s+\d{1,5}\s', re.UNICODE)
NOT_LICENSE_RE = re.compile(r'\bIntro\b|\bBill\b|\b[SA]\.? ?\d{3,}|\blaws?\b|regulation|Certificate of Appropriateness|ULURP', re.I)
LICENSE_RE = re.compile(r'licen[cs]e|liquor|sidewalk|roadway caf|dining out|wine|beer|cannabis|dispensary|cabaret', re.I)
_BAD_NAMES = re.compile(
    r'^(?:and|at|or|of|to|on)\b|\bat \d|^(?:a|an|the)?\s*(?:property|building|site|premises|location|lot|block|space|application|'
    r'new application|alteration|corridor|garage|parking|unknown|applicant)\b|wayfinding|'
    r'certificate|resolution|^manhattan cb|license|liquor|permit',
    re.I,
)


def clean_display(name: str) -> str:
    name = html.unescape(name).strip(' ,.;:"\'“”')
    name = re.sub(r'\s+', ' ', name)
    letters = [c for c in name if c.isalpha()]
    if letters and sum(c.isupper() for c in letters) / len(letters) > 0.8 and len(letters) > 3:
        keep = {'NYC', 'NY', 'USA', 'BBQ', 'II', 'III', 'IV', 'DT', 'LB', 'UN', 'BK', 'KBBQ', 'NYU', 'TFS', 'DOI'}
        name = ' '.join(w if w.strip('.,!') in keep or re.search(r'\d', w) else w.title() for w in name.split())
        name = re.sub(r"'S\b", "'s", name)
    return name


def strip_corp(name: str) -> str:
    return re.sub(r'\s*,?\s*' + _CORP, '', name, flags=re.I).strip(' ,.')


def normalize_business(name: str | None) -> str:
    if not name:
        return ''
    s = html.unescape(name).lower().replace('&', ' and ').replace('’', "'")
    s = re.sub(_CORP, ' ', s)
    s = re.sub(r"[^a-z0-9 ]+", ' ', s.replace("'", ''))
    s = re.sub(r'^(the)\s+', '', s.strip())
    return re.sub(r'\s+', ' ', s).strip()


def _valid_name(n: str) -> bool:
    n = n.strip()
    return 2 <= len(n) <= 80 and not _BAD_NAMES.search(n) and not re.fullmatch(r'[\d\s\W]+', n) and len(n.split()) <= 9


def parse_businesses(text: str | None, license_context: bool = True) -> list[dict]:
    """Return [{'name', 'legal_name', 'key'}] parsed from free text."""
    if not text:
        return []
    text = html.unescape(text).replace('’', "'")
    out: list[dict] = []
    seen = set()

    def addr_after(end: int) -> str:
        m2 = ADDR_RE.match(text, end) or ADDR_RE.search(text[end:end + 40])
        return m2 and normalize_street(m2.group('street')) and parse_addresses(m2.group(0))[0][0] or ''

    def add(name, legal=None, address=''):
        name = clean_display(name)
        if legal:
            legal = re.sub(r'\s+', ' ', html.unescape(legal)).strip(' ,;:')
        if name.lower() in _NULL_DBA or not _valid_name(name):
            if legal and _valid_name(strip_corp(legal)):
                name = strip_corp(legal)
            else:
                return
        key = normalize_business(name)
        if key and key not in seen and len(key) >= 2:
            seen.add(key)
            out.append({'name': name, 'legal_name': legal or '', 'key': key, 'address': address})

    for rx in (DBA_RE, DBA_LOOSE_RE):  # union: multi-applicant titles only have 'for' before the first
        for m in rx.finditer(text):
            add(m.group('dba'), m.group('legal'), addr_after(m.end()))
    if out:
        return out
    if license_context:
        for rx in (FOR_AT_RE, AT_COMMA_RE):
            for m in rx.finditer(text):
                legal = m.group('name')
                nm = strip_corp(legal)
                add(nm, legal if nm != legal.strip() else None, addr_after(m.end('name')))
            if out:
                return out
    return out


# ---------------------------------------------------------------- agencies
AGENCIES: list[tuple[str, str, str]] = [
    ('DOT', 'NYC Department of Transportation', r'Department of Transportation|\bDOT\b|Dining Out NYC'),
    ('SLA', 'New York State Liquor Authority', r'State Liquor Authority|\bSLA\b'),
    ('LPC', 'Landmarks Preservation Commission', r'Landmarks Preservation Commission|\bLPC\b'),
    ('BSA', 'Board of Standards and Appeals', r'Board of Standards and Appeals|\bBSA\b'),
    ('DCWP', 'Department of Consumer and Worker Protection', r'Consumer and Worker Protection|\bDCWP\b|Department of Consumer Affairs'),
    ('DOHMH', 'Department of Health and Mental Hygiene', r'Department of Health|\bDOHMH\b|Poison Control'),
    ('Parks', 'NYC Parks', r'Department of Parks|NYC Parks|Parks Department|Parks & Recreation|Parks and Recreation'),
    ('MTA', 'Metropolitan Transportation Authority', r'\bMTA\b|Metropolitan Transportation Authority|Congestion Pricing|Central Business District Tolling'),
    ('RGB', 'Rent Guidelines Board', r'Rent Guidelines Board'),
    ('DCP', 'Department of City Planning', r'City Planning|\bDCP\b|\bULURP\b'),
    ('HPD', 'Housing Preservation and Development', r'Housing Preservation|\bHPD\b'),
    ('DEP', 'Department of Environmental Protection / Water Board', r'Environmental Protection|\bDEP\b|Water Board'),
    ('DEC', 'NYS Department of Environmental Conservation', r'Environmental Conservation|\bDEC\b'),
    ('DOE', 'NYC Department of Education', r'Department of Education|\bDOE\b|Panel for Educational Policy'),
    ('NYPD', 'New York Police Department', r'\bNYPD\b|Precinct|Police Department'),
    ('FDNY', 'Fire Department', r'\bFDNY\b|Fire Department'),
    ('DSNY', 'Department of Sanitation', r'\bDSNY\b|Department of Sanitation'),
    ('PSC', 'NYS Public Service Commission', r'Public Service Commission|Con Edison|Con Ed\b|Sub-Metered Electric'),
    ('Redistricting Commission', 'NYC Districting Commission', r'Redistricting Commission|Districting Commission'),
    ('Charter Revision Commission', 'Charter Revision Commission', r'Charter Revision|Commission on Government Efficiency'),
    ('EDC', 'NYC Economic Development Corporation', r'Economic Development Corporation|\bNYCEDC\b|\bEDC\b'),
    ('Gaming Facility Board', 'NYS Gaming Facility Location Board', r'Casino|Gaming Facility|Community Advisory Committee \(CAC\)'),
    ('NYC Aging', 'NYC Department for the Aging', r'Department for the Aging|NYC Aging'),
    ('OCM', 'NYS Office of Cannabis Management', r'Cannabis Management|\bOCM\b'),
]
_AGENCY_RES = [(a, full, re.compile(p)) for a, full, p in AGENCIES]


def detect_agencies(text: str) -> list[tuple[str, str]]:
    return [(a, full) for a, full, rx in _AGENCY_RES if rx.search(text or '')]


def strip_html(s: str | None) -> str:
    s = re.sub(r'<[^>]+>', ' ', s or '')
    return re.sub(r'\s+', ' ', html.unescape(s)).strip()
