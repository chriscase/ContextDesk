DROP TRIGGER IF EXISTS experiment_decisions_no_update ON experiment_decisions;
DROP TRIGGER IF EXISTS experiment_helpfulness_no_update ON experiment_helpfulness;
DROP TRIGGER IF EXISTS experiment_packages_no_update ON experiment_packages;
DROP FUNCTION IF EXISTS experiment_decisions_immutable();
DROP FUNCTION IF EXISTS experiment_helpfulness_immutable();
DROP FUNCTION IF EXISTS experiment_packages_immutable();
DROP TABLE IF EXISTS experiment_decisions;
DROP TABLE IF EXISTS experiment_helpfulness;
DROP TABLE IF EXISTS experiment_packages;
