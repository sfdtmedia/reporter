cd /home/webadmin/analytics/analytics-reporter

export ANALYTICS_REPORT_EMAIL="analytics@ordinal-shield-130316.iam.gserviceaccount.com"
export ANALYTICS_REPORT_IDS="ga:17386173"
export ANALYTICS_KEY_PATH="Pantheon-34f2eb823685.json"

/usr/bin/nodejs /home/webadmin/analytics/analytics-reporter/bin/analytics --output /var/www/html/analytics/data/ --frequency=hourly --slim --verbose

/usr/bin/nodejs /home/webadmin/analytics/analytics-reporter/bin/analytics --output /var/www/html/analytics/data/ --frequency=hourly --slim --verbose --csv