# PSScriptAnalyzer settings for this repo (scanner trial, Dave 2026-11-03).
# The scripts here are console tools, so these rules are noise (69% of the 420 trial findings).
# Trial report: .claudedocs/2026-11-03-scanner-trial.md section 4.
@{
    ExcludeRules = @(
        'PSAvoidUsingWriteHost',
        'PSAvoidUsingPositionalParameters',
        'PSUseSingularNouns',
        'PSUseShouldProcessForStateChangingFunctions',
        'PSUseApprovedVerbs',
        'PSUseBOMForUnicodeEncodedFile'
    )
}
