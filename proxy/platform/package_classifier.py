"""
Package classifier — determines category for Python packages.

Strategy (in order):
1. Check static mapping (proxy/data/package_categories.json) — instant, covers 150+ common packages
2. Query PyPI JSON API for classifiers — async, one-time per package
3. Fallback to "Other"

Used by the /package-categories endpoint and called after successful pip install.
"""

import os
import json
import logging
from pathlib import Path

import httpx

logger = logging.getLogger(__name__)

# ─── Static data (loaded once at import) ─────────────────────────────────────

_DATA_DIR = Path(__file__).parent.parent / "data"
_CATEGORIES_FILE = _DATA_DIR / "package_categories.json"

_static_data = {}
_category_map = {}   # package_name → category
_import_aliases = {} # package_name → import statement


def _load_static_data():
    """Load the static categories JSON on first access."""
    global _static_data, _category_map, _import_aliases
    if _category_map:
        return  # Already loaded
    try:
        with open(_CATEGORIES_FILE, "r") as f:
            _static_data = json.load(f)
        _category_map = {k.lower(): v for k, v in _static_data.get("categories", {}).items()}
        _import_aliases = {k.lower(): v for k, v in _static_data.get("import_aliases", {}).items()}
        logger.info(f"Loaded {len(_category_map)} package categories, {len(_import_aliases)} import aliases")
    except Exception as e:
        logger.warning(f"Failed to load package categories: {e}")
        _category_map = {}
        _import_aliases = {}


# ─── PyPI classifier → category mapping ─────────────────────────────────────

_PYPI_TOPIC_MAP = {
    "Scientific/Engineering": "Data Science",
    "Scientific/Engineering :: Artificial Intelligence": "Machine Learning",
    "Scientific/Engineering :: Machine Learning": "Machine Learning",
    "Scientific/Engineering :: Information Analysis": "Data Science",
    "Scientific/Engineering :: Mathematics": "Data Science",
    "Scientific/Engineering :: Visualization": "Visualization",
    "Scientific/Engineering :: Image Recognition": "Machine Learning",
    "Multimedia :: Graphics": "Visualization",
    "Database": "Database & SQL",
    "Database :: Database Engines/Servers": "Database & SQL",
    "Internet :: WWW/HTTP": "Web & Networking",
    "Internet :: WWW/HTTP :: Dynamic Content": "Web & Networking",
    "Internet :: WWW/HTTP :: WSGI": "Web & Networking",
    "Software Development :: Libraries :: Python Modules": None,  # Too generic
    "Software Development :: Testing": "Testing & Dev",
    "Software Development :: Quality Assurance": "Testing & Dev",
    "System :: Systems Administration": "System",
    "System :: Monitoring": "System",
    "Utilities": "System",
    "Text Processing :: Markup": "File Formats",
    "Text Processing :: Markup :: XML": "File Formats",
}


def _classify_from_pypi_classifiers(classifiers: list[str]) -> str | None:
    """
    Map PyPI Trove classifiers to our category.
    Returns the most specific match, or None if no match.
    """
    best_match = None
    best_specificity = 0

    for classifier in classifiers:
        if not classifier.startswith("Topic :: "):
            continue
        topic = classifier.replace("Topic :: ", "")

        # Try most specific first (longer = more specific)
        for pattern, category in _PYPI_TOPIC_MAP.items():
            if category and topic.startswith(pattern):
                specificity = len(pattern)
                if specificity > best_specificity:
                    best_match = category
                    best_specificity = specificity

    return best_match


# ─── Public API ──────────────────────────────────────────────────────────────

def get_category(package_name: str) -> str:
    """Get category for a package from static mapping. Returns 'Other' if unknown."""
    _load_static_data()
    return _category_map.get(package_name.lower(), "Other")


def get_import_alias(package_name: str) -> str:
    """Get the recommended import statement for a package."""
    _load_static_data()
    alias = _import_aliases.get(package_name.lower())
    if alias:
        return alias
    # Generate a default import
    module_name = package_name.replace("-", "_").lower()
    return f"import {module_name}"


def get_all_categories() -> dict:
    """Return the full static category mapping."""
    _load_static_data()
    return dict(_category_map)


def get_all_import_aliases() -> dict:
    """Return all import aliases."""
    _load_static_data()
    return dict(_import_aliases)


def get_category_order() -> list:
    """Return the preferred display order for categories."""
    _load_static_data()
    return _static_data.get("category_order", [])


async def classify_from_pypi(package_name: str) -> str:
    """
    Query PyPI for package classifiers and determine category.
    Async — called after a successful pip install.
    Returns category string or "Other" if lookup fails.
    """
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(f"https://pypi.org/pypi/{package_name}/json")
            if resp.status_code != 200:
                return "Other"
            data = resp.json()
            classifiers = data.get("info", {}).get("classifiers", [])
            category = _classify_from_pypi_classifiers(classifiers)
            if category:
                # Cache in the static map for future lookups
                _category_map[package_name.lower()] = category
                logger.info(f"PyPI classified '{package_name}' → '{category}'")
                return category
    except Exception as e:
        logger.debug(f"PyPI lookup failed for {package_name}: {e}")

    return "Other"


async def classify_and_cache(package_name: str) -> str:
    """
    Get category: try static first, then PyPI lookup.
    Caches the result in memory for subsequent calls.
    """
    _load_static_data()
    # Check static mapping first
    category = _category_map.get(package_name.lower())
    if category:
        return category

    # Try PyPI
    category = await classify_from_pypi(package_name)
    return category
