#!/usr/bin/env python3
"""Reference producer + conformance validator for
``contextdesk.normalized_log_events.v1``.

Standard library only — no dependencies, so it can be dropped into any
producer's build. Run it two ways::

    python3 produce_and_validate.py --emit          # write a conforming file
    python3 produce_and_validate.py --validate FILE # validate one file
    python3 produce_and_validate.py --check <dir>   # validate the fixture corpus

``--check`` runs against the SAME frozen fixtures the Rust validator uses
(``fixtures/normalized-log-events/``), which is the point: three
implementations agreeing on one corpus is what makes this contract portable
under #826, rather than three separate readings of prose.

This is intentionally a *reference*, not a library. It implements the rules an
independent producer must get right, and nothing else.
"""

from __future__ import annotations

import argparse
import json
import pathlib
import re
import sys

SCHEMA_ID = "contextdesk.normalized_log_events.v1"
READER_VERSION = 1

MAX_LINE_BYTES = 1024 * 1024
MAX_CANONICAL_BYTES = 64 * 1024
MAX_ID_CHARS = 128
MAX_SEVERITY_NUMBER = 24
MAX_CORRELATIONS = 32
MAX_MESSAGE_CHARS = 64 * 1024
MAX_LOCAL_TEXT_CHARS = 256
MAX_ATTRIBUTES = 256
MAX_ATTRIBUTE_KEY_CHARS = 128
MAX_REDACTION_NOTE_CHARS = 1024
# Bounds parser work and stack use: a deeply nested attribute map is the cheap
# way to make a validator expensive.
MAX_JSON_DEPTH = 32

# Keys an older ContextDesk reader would treat as authoritative wall-clock
# time. A conforming header or event must never carry them outside the event's
# root "time" object: it could declare order_only while a sidecar "ts" epoch
# silently put the corpus on a wall clock.
# Must match cd_core::log_analysis::parse::TIMESTAMP_FIELD_ALIASES exactly.
# The ordinary reader can promote nested aliases, so a nested
# {"attributes":{"ts":...}} must be refused too — a top-level-only guard is
# weaker than the behaviour it guards against.
RESERVED_EVENT_KEYS = ("ts", "timestamp", "time", "@timestamp", "@t", "eventTime")

# The eleven typed correlation classes (#789). Trace and span are deliberately
# NOT here: they are their own event fields, so a span id cannot be routed into
# a trace slot through this mechanism.
CORRELATION_CLASSES = (
    "request",
    "session",
    "transaction",
    "activity",
    "audit",
    "flow",
    "boot",
    "container",
    "pod",
    "event",
    "query",
)

# RFC3339 with an EXPLICIT offset. A bare local timestamp is a guessed instant
# and has no representation in this contract.
INSTANT_RE = re.compile(
    r"^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?"
    r"([Zz]|[+-](?:0\d|1\d|2[0-3]):[0-5]\d)$"
)

# Evaluator-protection markers that must never appear in shipped evidence.
# Mirrors cd_core::incident_evidence::FORBIDDEN_MANIFEST_SENTINELS. A producer
# outside ContextDesk is unlikely to emit these by accident, but the shared
# fixture corpus is the definition of conformance, so a reference validator
# that skipped the check would silently disagree with the Rust one.
FORBIDDEN_SENTINELS = (
    "evaluator_truth",
    "evaluator-truth",
    "answer_key",
    "answer-key",
    "expected_diagnosis",
    "truth_inventory",
    "company-data",
)


def _has_sentinel(text) -> bool:
    if not isinstance(text, str):
        return False
    lowered = text.lower()
    return any(sentinel in lowered for sentinel in FORBIDDEN_SENTINELS)


TRACE_RE = re.compile(r"^[0-9a-f]{32}$")
SPAN_RE = re.compile(r"^[0-9a-f]{16}$")

# Timestamp legality matrix: resolution -> (instant, localText, resolvedTimezone)
# "req" required, "opt" optional, "no" forbidden.
LEGALITY = {
    "source_explicit": ("req", "opt", "no"),
    "producer_resolved": ("req", "req", "req"),
    "unresolved": ("no", "req", "no"),
    "order_only": ("no", "no", "no"),
}
WALL_RESOLUTIONS = {"source_explicit", "producer_resolved"}

# Frozen from chrono-tz 0.10.4 / IANA TZDB 2025b. The cross-language parity test
# makes drift visible whenever the authoritative Rust registry changes. Keeping
# the registry here avoids depending on an optional host tzdb (not installed on
# stock Windows Python) while preserving the dependency-free, drop-in script.
IANA_TZDB_VERSION = "2025b"
IANA_ZONES = frozenset("""
Africa/Abidjan Africa/Accra Africa/Addis_Ababa Africa/Algiers Africa/Asmara
Africa/Asmera Africa/Bamako Africa/Bangui Africa/Banjul Africa/Bissau Africa/Blantyre
Africa/Brazzaville Africa/Bujumbura Africa/Cairo Africa/Casablanca Africa/Ceuta
Africa/Conakry Africa/Dakar Africa/Dar_es_Salaam Africa/Djibouti Africa/Douala
Africa/El_Aaiun Africa/Freetown Africa/Gaborone Africa/Harare Africa/Johannesburg
Africa/Juba Africa/Kampala Africa/Khartoum Africa/Kigali Africa/Kinshasa Africa/Lagos
Africa/Libreville Africa/Lome Africa/Luanda Africa/Lubumbashi Africa/Lusaka
Africa/Malabo Africa/Maputo Africa/Maseru Africa/Mbabane Africa/Mogadishu
Africa/Monrovia Africa/Nairobi Africa/Ndjamena Africa/Niamey Africa/Nouakchott
Africa/Ouagadougou Africa/Porto-Novo Africa/Sao_Tome Africa/Timbuktu Africa/Tripoli
Africa/Tunis Africa/Windhoek America/Adak America/Anchorage America/Anguilla
America/Antigua America/Araguaina America/Argentina/Buenos_Aires
America/Argentina/Catamarca America/Argentina/ComodRivadavia America/Argentina/Cordoba
America/Argentina/Jujuy America/Argentina/La_Rioja America/Argentina/Mendoza
America/Argentina/Rio_Gallegos America/Argentina/Salta America/Argentina/San_Juan
America/Argentina/San_Luis America/Argentina/Tucuman America/Argentina/Ushuaia
America/Aruba America/Asuncion America/Atikokan America/Atka America/Bahia
America/Bahia_Banderas America/Barbados America/Belem America/Belize
America/Blanc-Sablon America/Boa_Vista America/Bogota America/Boise America/Buenos_Aires
America/Cambridge_Bay America/Campo_Grande America/Cancun America/Caracas
America/Catamarca America/Cayenne America/Cayman America/Chicago America/Chihuahua
America/Ciudad_Juarez America/Coral_Harbour America/Cordoba America/Costa_Rica
America/Coyhaique America/Creston America/Cuiaba America/Curacao America/Danmarkshavn
America/Dawson America/Dawson_Creek America/Denver America/Detroit America/Dominica
America/Edmonton America/Eirunepe America/El_Salvador America/Ensenada
America/Fort_Nelson America/Fort_Wayne America/Fortaleza America/Glace_Bay
America/Godthab America/Goose_Bay America/Grand_Turk America/Grenada America/Guadeloupe
America/Guatemala America/Guayaquil America/Guyana America/Halifax America/Havana
America/Hermosillo America/Indiana/Indianapolis America/Indiana/Knox
America/Indiana/Marengo America/Indiana/Petersburg America/Indiana/Tell_City
America/Indiana/Vevay America/Indiana/Vincennes America/Indiana/Winamac
America/Indianapolis America/Inuvik America/Iqaluit America/Jamaica America/Jujuy
America/Juneau America/Kentucky/Louisville America/Kentucky/Monticello America/Knox_IN
America/Kralendijk America/La_Paz America/Lima America/Los_Angeles America/Louisville
America/Lower_Princes America/Maceio America/Managua America/Manaus America/Marigot
America/Martinique America/Matamoros America/Mazatlan America/Mendoza America/Menominee
America/Merida America/Metlakatla America/Mexico_City America/Miquelon America/Moncton
America/Monterrey America/Montevideo America/Montreal America/Montserrat America/Nassau
America/New_York America/Nipigon America/Nome America/Noronha
America/North_Dakota/Beulah America/North_Dakota/Center America/North_Dakota/New_Salem
America/Nuuk America/Ojinaga America/Panama America/Pangnirtung America/Paramaribo
America/Phoenix America/Port-au-Prince America/Port_of_Spain America/Porto_Acre
America/Porto_Velho America/Puerto_Rico America/Punta_Arenas America/Rainy_River
America/Rankin_Inlet America/Recife America/Regina America/Resolute America/Rio_Branco
America/Rosario America/Santa_Isabel America/Santarem America/Santiago
America/Santo_Domingo America/Sao_Paulo America/Scoresbysund America/Shiprock
America/Sitka America/St_Barthelemy America/St_Johns America/St_Kitts America/St_Lucia
America/St_Thomas America/St_Vincent America/Swift_Current America/Tegucigalpa
America/Thule America/Thunder_Bay America/Tijuana America/Toronto America/Tortola
America/Vancouver America/Virgin America/Whitehorse America/Winnipeg America/Yakutat
America/Yellowknife Antarctica/Casey Antarctica/Davis Antarctica/DumontDUrville
Antarctica/Macquarie Antarctica/Mawson Antarctica/McMurdo Antarctica/Palmer
Antarctica/Rothera Antarctica/South_Pole Antarctica/Syowa Antarctica/Troll
Antarctica/Vostok Arctic/Longyearbyen Asia/Aden Asia/Almaty Asia/Amman Asia/Anadyr
Asia/Aqtau Asia/Aqtobe Asia/Ashgabat Asia/Ashkhabad Asia/Atyrau Asia/Baghdad
Asia/Bahrain Asia/Baku Asia/Bangkok Asia/Barnaul Asia/Beirut Asia/Bishkek Asia/Brunei
Asia/Calcutta Asia/Chita Asia/Choibalsan Asia/Chongqing Asia/Chungking Asia/Colombo
Asia/Dacca Asia/Damascus Asia/Dhaka Asia/Dili Asia/Dubai Asia/Dushanbe Asia/Famagusta
Asia/Gaza Asia/Harbin Asia/Hebron Asia/Ho_Chi_Minh Asia/Hong_Kong Asia/Hovd Asia/Irkutsk
Asia/Istanbul Asia/Jakarta Asia/Jayapura Asia/Jerusalem Asia/Kabul Asia/Kamchatka
Asia/Karachi Asia/Kashgar Asia/Kathmandu Asia/Katmandu Asia/Khandyga Asia/Kolkata
Asia/Krasnoyarsk Asia/Kuala_Lumpur Asia/Kuching Asia/Kuwait Asia/Macao Asia/Macau
Asia/Magadan Asia/Makassar Asia/Manila Asia/Muscat Asia/Nicosia Asia/Novokuznetsk
Asia/Novosibirsk Asia/Omsk Asia/Oral Asia/Phnom_Penh Asia/Pontianak Asia/Pyongyang
Asia/Qatar Asia/Qostanay Asia/Qyzylorda Asia/Rangoon Asia/Riyadh Asia/Saigon
Asia/Sakhalin Asia/Samarkand Asia/Seoul Asia/Shanghai Asia/Singapore Asia/Srednekolymsk
Asia/Taipei Asia/Tashkent Asia/Tbilisi Asia/Tehran Asia/Tel_Aviv Asia/Thimbu
Asia/Thimphu Asia/Tokyo Asia/Tomsk Asia/Ujung_Pandang Asia/Ulaanbaatar Asia/Ulan_Bator
Asia/Urumqi Asia/Ust-Nera Asia/Vientiane Asia/Vladivostok Asia/Yakutsk Asia/Yangon
Asia/Yekaterinburg Asia/Yerevan Atlantic/Azores Atlantic/Bermuda Atlantic/Canary
Atlantic/Cape_Verde Atlantic/Faeroe Atlantic/Faroe Atlantic/Jan_Mayen Atlantic/Madeira
Atlantic/Reykjavik Atlantic/South_Georgia Atlantic/St_Helena Atlantic/Stanley
Australia/ACT Australia/Adelaide Australia/Brisbane Australia/Broken_Hill
Australia/Canberra Australia/Currie Australia/Darwin Australia/Eucla Australia/Hobart
Australia/LHI Australia/Lindeman Australia/Lord_Howe Australia/Melbourne Australia/NSW
Australia/North Australia/Perth Australia/Queensland Australia/South Australia/Sydney
Australia/Tasmania Australia/Victoria Australia/West Australia/Yancowinna Brazil/Acre
Brazil/DeNoronha Brazil/East Brazil/West CET CST6CDT Canada/Atlantic Canada/Central
Canada/Eastern Canada/Mountain Canada/Newfoundland Canada/Pacific Canada/Saskatchewan
Canada/Yukon Chile/Continental Chile/EasterIsland Cuba EET EST EST5EDT Egypt Eire
Etc/GMT Etc/GMT+0 Etc/GMT+1 Etc/GMT+10 Etc/GMT+11 Etc/GMT+12 Etc/GMT+2 Etc/GMT+3
Etc/GMT+4 Etc/GMT+5 Etc/GMT+6 Etc/GMT+7 Etc/GMT+8 Etc/GMT+9 Etc/GMT-0 Etc/GMT-1
Etc/GMT-10 Etc/GMT-11 Etc/GMT-12 Etc/GMT-13 Etc/GMT-14 Etc/GMT-2 Etc/GMT-3 Etc/GMT-4
Etc/GMT-5 Etc/GMT-6 Etc/GMT-7 Etc/GMT-8 Etc/GMT-9 Etc/GMT0 Etc/Greenwich Etc/UCT Etc/UTC
Etc/Universal Etc/Zulu Europe/Amsterdam Europe/Andorra Europe/Astrakhan Europe/Athens
Europe/Belfast Europe/Belgrade Europe/Berlin Europe/Bratislava Europe/Brussels
Europe/Bucharest Europe/Budapest Europe/Busingen Europe/Chisinau Europe/Copenhagen
Europe/Dublin Europe/Gibraltar Europe/Guernsey Europe/Helsinki Europe/Isle_of_Man
Europe/Istanbul Europe/Jersey Europe/Kaliningrad Europe/Kiev Europe/Kirov Europe/Kyiv
Europe/Lisbon Europe/Ljubljana Europe/London Europe/Luxembourg Europe/Madrid
Europe/Malta Europe/Mariehamn Europe/Minsk Europe/Monaco Europe/Moscow Europe/Nicosia
Europe/Oslo Europe/Paris Europe/Podgorica Europe/Prague Europe/Riga Europe/Rome
Europe/Samara Europe/San_Marino Europe/Sarajevo Europe/Saratov Europe/Simferopol
Europe/Skopje Europe/Sofia Europe/Stockholm Europe/Tallinn Europe/Tirane Europe/Tiraspol
Europe/Ulyanovsk Europe/Uzhgorod Europe/Vaduz Europe/Vatican Europe/Vienna
Europe/Vilnius Europe/Volgograd Europe/Warsaw Europe/Zagreb Europe/Zaporozhye
Europe/Zurich GB GB-Eire GMT GMT+0 GMT-0 GMT0 Greenwich HST Hongkong Iceland
Indian/Antananarivo Indian/Chagos Indian/Christmas Indian/Cocos Indian/Comoro
Indian/Kerguelen Indian/Mahe Indian/Maldives Indian/Mauritius Indian/Mayotte
Indian/Reunion Iran Israel Jamaica Japan Kwajalein Libya MET MST MST7MDT
Mexico/BajaNorte Mexico/BajaSur Mexico/General NZ NZ-CHAT Navajo PRC PST8PDT
Pacific/Apia Pacific/Auckland Pacific/Bougainville Pacific/Chatham Pacific/Chuuk
Pacific/Easter Pacific/Efate Pacific/Enderbury Pacific/Fakaofo Pacific/Fiji
Pacific/Funafuti Pacific/Galapagos Pacific/Gambier Pacific/Guadalcanal Pacific/Guam
Pacific/Honolulu Pacific/Johnston Pacific/Kanton Pacific/Kiritimati Pacific/Kosrae
Pacific/Kwajalein Pacific/Majuro Pacific/Marquesas Pacific/Midway Pacific/Nauru
Pacific/Niue Pacific/Norfolk Pacific/Noumea Pacific/Pago_Pago Pacific/Palau
Pacific/Pitcairn Pacific/Pohnpei Pacific/Ponape Pacific/Port_Moresby Pacific/Rarotonga
Pacific/Saipan Pacific/Samoa Pacific/Tahiti Pacific/Tarawa Pacific/Tongatapu
Pacific/Truk Pacific/Wake Pacific/Wallis Pacific/Yap Poland Portugal ROC ROK Singapore
Turkey UCT US/Alaska US/Aleutian US/Arizona US/Central US/East-Indiana US/Eastern
US/Hawaii US/Indiana-Starke US/Michigan US/Mountain US/Pacific US/Samoa UTC Universal
W-SU WET Zulu
""".split())


def _is_instant(value) -> bool:
    if not isinstance(value, str) or value.endswith("-00:00"):
        return False
    match = INSTANT_RE.match(value)
    if not match:
        return False
    year, month, day, hour, minute, second = map(int, match.groups()[:6])
    leap = year % 4 == 0 and (year % 100 != 0 or year % 400 == 0)
    days = (0, 31, 29 if leap else 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31)
    return (
        1 <= month <= 12
        and 1 <= day <= days[month]
        and hour <= 23
        and minute <= 59
        and second <= 60
    )


class DuplicateKeyError(ValueError):
    """A decoded JSON object key appeared twice in one object."""


def _loads_no_duplicates(raw: str):
    def object_pairs(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise DuplicateKeyError(key)
            result[key] = value
        return result

    return json.loads(raw, object_pairs_hook=object_pairs)


def _json_depth(value) -> int:
    maximum = 0
    pending = [(value, 0)]
    while pending:
        current, parent_depth = pending.pop()
        if not isinstance(current, (dict, list)):
            continue
        depth = parent_depth + 1
        if depth > MAX_JSON_DEPTH:
            return depth
        maximum = max(maximum, depth)
        children = current.values() if isinstance(current, dict) else current
        pending.extend((child, depth) for child in children)
    return maximum


def _contains_reserved_timestamp_key(value, allow_root_time, depth=0) -> bool:
    if isinstance(value, list):
        return any(
            _contains_reserved_timestamp_key(child, False, depth + 1)
            for child in value
        )
    if not isinstance(value, dict):
        return False
    for key, child in value.items():
        root_time = (
            depth == 0
            and allow_root_time
            and key == "time"
            and isinstance(child, dict)
        )
        if (key in RESERVED_EVENT_KEYS and not root_time) or _contains_reserved_timestamp_key(
            child, False, depth + 1
        ):
            return True
    return False


def _is_iana_zone(value) -> bool:
    """A real IANA zone, not merely a plausible-looking string."""
    return isinstance(value, str) and value in IANA_ZONES


def _is_int(value) -> bool:
    # bool is a subclass of int in Python; True must not pass as a sequence
    # number or a version.
    return isinstance(value, int) and not isinstance(value, bool)


def _is_identifier(value) -> bool:
    return (
        isinstance(value, str)
        and value.strip() != ""
        and len(value) <= MAX_ID_CHARS
        # Rust's char::is_control covers C0 AND C1 (U+0080-U+009F); matching
        # it exactly is what keeps the three implementations in agreement.
        and not any(
            ord(ch) < 0x20 or 0x7F <= ord(ch) <= 0x9F for ch in value
        )
    )


def validate_time(time, errors, line_no):
    if not isinstance(time, dict):
        errors.append((line_no, "event_malformed", "time"))
        return
    resolution = time.get("resolution")
    basis = time.get("basis")
    if resolution not in LEGALITY:
        errors.append((line_no, "time_basis_inconsistent", "time.resolution"))
        return
    if basis not in ("wall", "relative", "order"):
        errors.append((line_no, "time_basis_inconsistent", "time.basis"))
        return

    want_instant, want_local, want_zone = LEGALITY[resolution]
    have = {
        "instant": time.get("instant") is not None,
        "localText": time.get("localText") is not None,
        "resolvedTimezone": time.get("resolvedTimezone") is not None,
    }

    if want_instant == "req" and not have["instant"]:
        errors.append((line_no, "instant_required", "time.instant"))
    if want_instant == "no" and have["instant"]:
        # The guessed-instant guard.
        errors.append((line_no, "instant_not_permitted", "time.instant"))
    if have["instant"] and not _is_instant(time.get("instant")):
        errors.append((line_no, "instant_malformed", "time.instant"))

    if want_local == "req" and not have["localText"]:
        errors.append((line_no, "local_text_required", "time.localText"))
    if want_local == "req" and have["localText"] and (
        not isinstance(time.get("localText"), str)
        or not time.get("localText").strip()
    ):
        errors.append((line_no, "local_text_required", "time.localText"))
    if have["localText"] and (
        not isinstance(time.get("localText"), str)
        or len(time.get("localText")) > MAX_LOCAL_TEXT_CHARS
    ):
        errors.append((line_no, "bounds_exceeded", "time.localText"))
    if want_local == "no" and have["localText"]:
        errors.append((line_no, "time_basis_inconsistent", "time.localText"))

    if want_zone == "req" and not have["resolvedTimezone"]:
        errors.append((line_no, "resolved_timezone_invalid", "time.resolvedTimezone"))
    if want_zone == "no" and have["resolvedTimezone"]:
        errors.append((line_no, "resolved_timezone_invalid", "time.resolvedTimezone"))
    if have["resolvedTimezone"] and not _is_iana_zone(time.get("resolvedTimezone")):
        # A real zone, not merely a plausible-looking string: producer_resolved
        # provenance is only worth anything if it is checkable.
        errors.append((line_no, "resolved_timezone_invalid", "time.resolvedTimezone"))

    wall_expected = resolution in WALL_RESOLUTIONS
    if wall_expected and basis != "wall":
        errors.append((line_no, "time_basis_inconsistent", "time.basis"))
    if not wall_expected and basis == "wall":
        errors.append((line_no, "time_basis_inconsistent", "time.basis"))

    observed = time.get("observed")
    if observed is not None and not _is_instant(observed):
        errors.append((line_no, "instant_malformed", "time.observed"))


def validate_event(event, expected_seq, errors, line_no, raw=None):
    if _json_depth(event) > MAX_JSON_DEPTH:
        errors.append((line_no, "depth_exceeded", None))
    if _contains_reserved_timestamp_key(event, True):
        errors.append((line_no, "reserved_key_present", None))

    if not _is_int(event.get("sourceSeq")) or event.get("sourceSeq") != expected_seq:
        errors.append((line_no, "sequence_not_contiguous", "sourceSeq"))

    message = event.get("message")
    if not isinstance(message, str):
        errors.append((line_no, "event_malformed", "message"))
    elif len(message) > MAX_MESSAGE_CHARS:
        errors.append((line_no, "bounds_exceeded", "message"))

    if not isinstance(event.get("time"), dict):
        errors.append((line_no, "event_malformed", "time"))

    validate_time(event.get("time"), errors, line_no)

    severity = event.get("severity")
    if (
        not isinstance(severity, dict)
        or severity.get("confidence") not in ("high", "medium", "low")
        or severity.get("provenance")
        not in ("source_declared", "schema_mapped", "text_inferred", "absent")
    ):
        errors.append((line_no, "event_malformed", "severity"))
    else:
        canonical = severity.get("canonical")
        if canonical is not None and (
            not _is_int(canonical) or canonical < 0 or canonical > MAX_SEVERITY_NUMBER
        ):
            errors.append(
                (line_no, "severity_number_out_of_range", "severity.canonical")
            )
        # confidence and provenance must agree, or a guess could wear the
        # clothes of source truth.
        prov, conf = severity["provenance"], severity["confidence"]
        coherent = (
            (prov == "source_declared" and conf == "high")
            or (prov == "schema_mapped" and conf in ("high", "medium"))
            or (prov == "text_inferred" and conf == "low")
            or prov == "absent"
        )
        if not coherent:
            errors.append((line_no, "severity_provenance_inconsistent", "severity"))
        if prov == "absent" and (
            "raw" in severity or "canonical" in severity
        ):
            errors.append((line_no, "severity_provenance_inconsistent", "severity"))
        if "raw" in severity and _json_depth(severity.get("raw")) > MAX_JSON_DEPTH:
            errors.append((line_no, "depth_exceeded", "severity.raw"))

    trace = event.get("traceId")
    if trace is not None and (
        not isinstance(trace, str) or not TRACE_RE.match(trace) or set(trace) == {"0"}
    ):
        errors.append((line_no, "trace_identifier_malformed", "traceId"))
    span = event.get("spanId")
    if span is not None and (
        not isinstance(span, str) or not SPAN_RE.match(span) or set(span) == {"0"}
    ):
        errors.append((line_no, "trace_identifier_malformed", "spanId"))

    attributes = event.get("attributes")
    if "attributes" in event and not isinstance(attributes, dict):
        errors.append((line_no, "event_malformed", "attributes"))
    elif isinstance(attributes, dict):
        if len(attributes) > MAX_ATTRIBUTES:
            errors.append((line_no, "bounds_exceeded", "attributes"))
        for key, value in attributes.items():
            if not key or len(key) > MAX_ATTRIBUTE_KEY_CHARS:
                errors.append((line_no, "bounds_exceeded", "attributes"))
            if _json_depth(value) > MAX_JSON_DEPTH:
                errors.append((line_no, "depth_exceeded", "attributes"))
                break

    correlations = event.get("correlations", [])
    if not isinstance(correlations, list):
        errors.append((line_no, "event_malformed", "correlations"))
        correlations = []
    if len(correlations) > MAX_CORRELATIONS:
        errors.append((line_no, "bounds_exceeded", "correlations"))
    seen = set()
    for correlation in correlations:
        if not isinstance(correlation, dict):
            errors.append((line_no, "event_malformed", "correlations"))
            continue
        cls = correlation.get("class")
        if cls not in CORRELATION_CLASSES:
            errors.append((line_no, "event_malformed", "correlations"))
            continue
        if cls in seen:
            errors.append((line_no, "duplicate_correlation_class", "correlations"))
        seen.add(cls)
        if not _is_identifier(correlation.get("value")):
            errors.append((line_no, "identifier_invalid", "correlations"))

    for field in ("message", "canonical"):
        if _has_sentinel(event.get(field)):
            errors.append((line_no, "forbidden_sentinel", field))

    canonical = event.get("canonical")
    if not isinstance(canonical, str) or canonical == "":
        errors.append((line_no, "canonical_invalid", "canonical"))
    elif len(canonical.encode("utf-8")) > MAX_CANONICAL_BYTES:
        errors.append((line_no, "canonical_invalid", "canonical"))
    if "canonicalTruncated" in event and not isinstance(
        event.get("canonicalTruncated"), bool
    ):
        errors.append((line_no, "event_malformed", "canonicalTruncated"))
    for field in ("logger", "service", "host"):
        if field in event and (
            not isinstance(event.get(field), str)
            or len(event.get(field)) > MAX_ID_CHARS
        ):
            errors.append((line_no, "bounds_exceeded", field))


def validate_file(text: str):
    """Return a list of ``(line, code, location)`` findings. Empty means valid."""
    errors = []
    lines = text.split("\n")
    if not text.strip():
        return [(0, "missing_header", None)]

    header_line = lines[0][:-1] if lines[0].endswith("\r") else lines[0]
    if len(header_line.encode("utf-8")) > MAX_LINE_BYTES:
        errors.append((1, "line_too_long", None))
    try:
        header = _loads_no_duplicates(header_line)
        if not isinstance(header, dict):
            raise ValueError
    except DuplicateKeyError:
        errors.append((1, "header_malformed", "duplicateKey"))
        header = json.loads(header_line)
    except Exception:
        errors.append((1, "header_malformed", None))
        header = None

    if header is not None:
        if _json_depth(header) > MAX_JSON_DEPTH:
            errors.append((1, "depth_exceeded", None))
        if _contains_reserved_timestamp_key(header, False):
            errors.append((1, "reserved_key_present", None))
        if header.get("schemaId") != SCHEMA_ID:
            errors.append((1, "schema_id_invalid", "schemaId"))
        version = header.get("minReaderVersion")
        if not _is_int(version) or version < 1:
            errors.append((1, "min_reader_version_invalid", "minReaderVersion"))
        elif version > READER_VERSION:
            errors.append((1, "reader_too_old", "minReaderVersion"))
        for field in ("sourceId", "sourceLabel"):
            if _has_sentinel(header.get(field)):
                errors.append((1, "forbidden_sentinel", field))
        redaction = header.get("redaction")
        if isinstance(redaction, dict) and _has_sentinel(redaction.get("note")):
            errors.append((1, "forbidden_sentinel", "redaction.note"))
        if not _is_identifier(header.get("sourceId")):
            errors.append((1, "identifier_invalid", "sourceId"))
        if "sourceLabel" in header and (
            not isinstance(header.get("sourceLabel"), str)
            or len(header.get("sourceLabel")) > MAX_ID_CHARS
        ):
            errors.append((1, "identifier_invalid", "sourceLabel"))
        producer = header.get("producer")
        if not isinstance(producer, dict) or not _is_identifier(
            producer.get("name")
        ) or not _is_identifier(producer.get("version")):
            errors.append((1, "identifier_invalid", "producer"))
        if "redaction" in header and (
            not isinstance(redaction, dict)
            or not isinstance(redaction.get("credentialsRemoved"), bool)
            or not isinstance(redaction.get("personalDataRemoved"), bool)
            or (
                "note" in redaction
                and (
                    not isinstance(redaction.get("note"), str)
                    or len(redaction.get("note")) > MAX_REDACTION_NOTE_CHARS
                )
            )
        ):
            errors.append((1, "header_malformed", "redaction"))

    expected_seq = 0
    for index, physical in enumerate(lines[1:], start=2):
        raw = physical[:-1] if physical.endswith("\r") else physical
        if raw.strip() == "":
            continue
        if len(raw.encode("utf-8")) > MAX_LINE_BYTES:
            errors.append((index, "line_too_long", None))
            continue
        try:
            event = _loads_no_duplicates(raw)
            if not isinstance(event, dict):
                raise ValueError
        except DuplicateKeyError:
            errors.append((index, "event_malformed", "duplicateKey"))
            event = json.loads(raw)
        except Exception:
            errors.append((index, "event_malformed", None))
            expected_seq += 1
            continue
        validate_event(event, expected_seq, errors, index, raw)
        seq = event.get("sourceSeq")
        expected_seq = (seq + 1) if _is_int(seq) else expected_seq + 1

    return errors


def emit_example() -> str:
    """A minimal conforming file, showing all four time resolutions."""
    header = {
        "schemaId": SCHEMA_ID,
        "minReaderVersion": 1,
        "sourceId": "checkout-api",
        "producer": {"name": "python-reference-producer", "version": "1.0.0"},
        # Advisory only. ContextDesk re-redacts regardless of what we claim.
        "redaction": {"credentialsRemoved": True, "personalDataRemoved": False},
    }

    def event(seq, time, message, canonical):
        return {
            "sourceSeq": seq,
            "time": time,
            "severity": {
                "raw": 6,
                "canonical": 9,
                "confidence": "high",
                "provenance": "source_declared",
            },
            "message": message,
            "canonical": canonical,
        }

    rows = [
        header,
        event(
            0,
            {
                "basis": "wall",
                "resolution": "source_explicit",
                "instant": "2026-01-01T00:00:00Z",
            },
            "explicit offset in the source",
            "2026-01-01T00:00:00Z INFO explicit offset in the source",
        ),
        event(
            1,
            {
                "basis": "wall",
                "resolution": "producer_resolved",
                "instant": "2026-01-01T00:00:00-06:00",
                "localText": "2026-01-01 00:00:00",
                "resolvedTimezone": "America/Chicago",
            },
            "producer resolved a zone-less local time",
            "2026-01-01 00:00:00 INFO producer resolved a zone-less local time",
        ),
        event(
            2,
            {
                "basis": "order",
                "resolution": "unresolved",
                "localText": "2026-01-01 00:00:00",
            },
            "local time we could not resolve, so no instant is emitted",
            "2026-01-01 00:00:00 INFO local time we could not resolve",
        ),
        event(
            3,
            {"basis": "order", "resolution": "order_only"},
            "no usable time at all",
            "INFO no usable time at all",
        ),
    ]
    return "\n".join(json.dumps(row, separators=(",", ":"), sort_keys=True) for row in rows) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--emit", action="store_true", help="print a conforming file")
    parser.add_argument("--validate", metavar="FILE", help="validate one JSONL file")
    parser.add_argument("--check", metavar="FIXTURE_DIR", help="validate a fixture corpus")
    parser.add_argument(
        "--list-timezones",
        action="store_true",
        help="print the frozen IANA version and accepted zone names",
    )
    args = parser.parse_args()

    if args.list_timezones:
        print(IANA_TZDB_VERSION)
        print(*sorted(IANA_ZONES), sep="\n")
        return 0

    if args.emit:
        text = emit_example()
        errors = validate_file(text)
        if errors:
            print(f"BUG: emitted file does not validate: {errors}", file=sys.stderr)
            return 2
        sys.stdout.write(text)
        return 0

    if args.validate:
        errors = validate_file(pathlib.Path(args.validate).read_text())
        print("conforming" if not errors else f"NOT conforming: {len(errors)} diagnostic(s)")
        return 0 if not errors else 1

    if args.check:
        root = pathlib.Path(args.check)
        failures = 0
        checked = 0
        for expectation in ("valid", "invalid"):
            directory = root / expectation
            for path in sorted(directory.glob("*.jsonl")):
                checked += 1
                errors = validate_file(path.read_text())
                ok = not errors
                want_ok = expectation == "valid"
                if ok != want_ok:
                    failures += 1
                    print(
                        f"FAIL {expectation}/{path.name}: "
                        f"expected {'valid' if want_ok else 'invalid'}, got {errors}",
                        file=sys.stderr,
                    )
        print(f"python conformance: {checked} fixtures checked, {failures} disagreement(s)")
        return 1 if failures else 0

    parser.print_help()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
