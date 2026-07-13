# Authored by: Mohit Singh
from business_scout_worker.settings import load_settings


def test_loads_with_sane_defaults_from_the_test_environment() -> None:
    settings = load_settings()

    assert settings.environment == "test"
    assert settings.database_url.startswith("postgresql://")
    assert settings.poll_interval_seconds > 0
