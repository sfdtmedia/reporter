/*
 * Workhorse module for Google Analytics interaction.
 */

var googleapis = require('googleapis'),
    ga = googleapis.analytics('v3'),
    fs = require('fs'),
    path = require('path'),
    _ = require('lodash');

var config = require('./config');

// Pre-load the keyfile from the OS
// prevents errors when starting JWT
var key;
if (config.key)
    key = config.key;
else if (config.key_file && fs.existsSync(config.key_file)) {
    key = fs.readFileSync(config.key_file);
    if (config.key_file.search(".json$"))
        key = JSON.parse(key).private_key;
}
else
  key = null;

var jwt = new googleapis.auth.JWT(
    config.email,
    null,
    key,
    ['https://www.googleapis.com/auth/analytics.readonly']
);

// The reports we want to run.
var reports_path = config.reports_file || (path.join(__dirname, "reports/reports.json"));
var reports = JSON.parse(fs.readFileSync(reports_path)).reports;
var by_name = {};
for (var i=0; i<reports.length; i++)
    by_name[reports[i].name] = reports[i];

// Google Analytics data fetching and transformation utilities.
// This should really move to its own analytics.js file.
var Analytics = {

    reports: by_name,

    query: function(report, callback) {

        // Abort if the report isn't defined.
        if (!report) return callback();

        // Insert IDs and auth data. Dupe the object so it doesn't
        // modify the report object for later work.
        var query = {};

        if (report.query.dimensions)
            query.dimensions = report.query.dimensions.join(",");

        if (report.query.metrics)
            query.metrics = report.query.metrics.join(",");

        if (report.query['start-date'])
            query["start-date"] = report.query['start-date'];
        if (report.query['end-date'])
            query["end-date"] = report.query['end-date'];

        // never sample data - this should be fine
        query['samplingLevel'] = "HIGHER_PRECISION";

        // Optional filters.
        var filters = [];
        if (report.query.filters)
            filters = filters.concat(report.query.filters);

        if (report.filters)
            filters = filters.concat(report.filters);

        if (filters.length > 0)
            query.filters = filters.join(";");

        query['max-results'] = report.query['max-results'] || 10000;

        if (report.query['sort'])
            query['sort'] = report.query['sort'];


        // Specify the account, and auth token.
        query.ids = config.account.ids;
        query.auth = jwt;

        var api_call;
        if (report.realtime)
            api_call = ga.data.realtime.get;
        else
            api_call = ga.data.ga.get;

        jwt.authorize(function(err, result) {
            if (err) return callback(err, null);

            api_call(query, function(err, result) {
                if (err) return callback(err, null);

                // if (config.debug)
                //     fs.writeFileSync("data/google/" + report.name + ".json", JSON.stringify(result, null, 2));

                callback(null, Analytics.process(report, result));
            });
        });
    },

    // translate 20141228 -> 2014-12-28
    date_format: function(in_date) {
        // This happens in screen-size for some reason.
        // Return original string.
        if (in_date == "(other)") return in_date;

        return [in_date.substr(0,4), in_date.substr(4, 2), in_date.substr(6, 2)].join("-")
    },

    mapping: {
        "ga:date": "date",
        "ga:hour": "hour",
        "ga:users": "visitors",
        "rt:activeUsers": "active_visitors",
        "rt:pagePath": "page",
        "rt:pageTitle": "page_title",
        "ga:sessions": "visits",
        "ga:deviceCategory": "device",
        "ga:operatingSystem": "os",
        "ga:operatingSystemVersion": "os_version",
        "ga:hostname": "domain",
        "ga:browser" : 'browser',
        "ga:browserVersion" : "browser_version",
        "ga:source": "source",
        "ga:pagePath": "page",
        "ga:pageTitle": "page_title",
        "ga:pageviews": "visits",
        "ga:country": "country",
        "ga:city": 'city',
        "ga:eventLabel": "event_label",
        "ga:totalEvents": "total_events",
        "ga:landingPagePath": "landing_page",
        "ga:exitPagePath": "exit_page",
        "ga:source": "source",
        "ga:hasSocialSourceReferral": "has_social_referral",
        "ga:referralPath": "referral_path",
        "ga:pageviews": "pageviews",
        "ga:users": "users",
        "ga:pageviewsPerSession": "pageviews_per_session",
        "ga:avgSessionDuration": "avg_session_duration",
        "ga:exits": "exits",
        "ga:language": "language",
        "ga:screenResolution": "screen_resolution",
        "ga:mobileDeviceModel": "mobile_device",
        "rt:country": "country",
        "rt:city": "city",
        "rt:totalEvents": "total_events",
        "rt:eventLabel": "event_label"
    },

    // Given a report and a raw google response, transform it into our schema.
    process: function(report, data) {
        var result = {
            name: report.name,
            query: data.query,
            meta: report.meta,
            data: [],
            totals: {}
        };

        // this is destructive to the original data, but should be fine
        delete result.query.ids;

        // If you use a filter that results in no data, you get null
        // back from google and need to protect against it.
        if (!data || !data.rows) {
          return result;
        }

        // datestamp all reports, will be serialized in JSON as ISO 8601
        result.taken_at = new Date();

        // data.rows is missing if there are no results
        if (data.totalResults > 0) {

            // get indices of column headers, for reference in client-side thresholds
            var columnIndices = {};
            for (var c = 0; c < data.columnHeaders.length; c++)
                columnIndices[data.columnHeaders[c].name] = c;

            // Calculate each individual data point.
            for (var i=0; i<data.rows.length; i++) {
                var row = data.rows[i];

                // allow client-side imposition of a value threshold, where it can't
                // be done at the server-side (e.g. metric filters on RT reports)
                if (report.threshold) {
                    if (parseInt(row[columnIndices[report.threshold.field]]) < report.threshold.value)
                        continue;
                }

                var point = {};
                for (var j=0; j<row.length; j++) {

                    // Some reports may decide to cut fields from the output.
                    if (report.cut && _.contains(report.cut, data.columnHeaders[j].name))
                        continue;

                    var field = Analytics.mapping[data.columnHeaders[j].name] || data.columnHeaders[j].name;
                    var value = row[j];

                    if (field == "date")
                        value = Analytics.date_format(value);

                    point[field] = value;
                }

                if (report.realtime && config.account.hostname)
                  point.domain = config.account.hostname;

                result.data.push(point);
            }

            // Go through those data points to calculate totals.
            // Right now, this is totally report-specific.
            if ((result.data.length > 0) && ("visitors" in result.data[0])) {
                result.totals.visitors = 0;
                for (var i=0; i<result.data.length; i++)
                    result.totals.visitors += parseInt(result.data[i].visitors);
            }
            if ((result.data.length > 0) && ("visits" in result.data[0])) {
                result.totals.visits = 0;
                for (var i=0; i<result.data.length; i++)
                    result.totals.visits += parseInt(result.data[i].visits);
            }
            if ((result.data.length > 0) && ("pageviews" in result.data[0])) {
                result.totals.visits = 0;
                for (var i=0; i<result.data.length; i++)
                    result.totals.visits += parseInt(result.data[i].pageviews);
            }
            
            
            if (_.startsWith(report.name, "device_model")) {
                result.totals.device_models = {};
                for (var i=0; i<result.data.length; i++) {
                    if(typeof result.totals.device_models[result.data[i].mobile_device] == "undefined") {
                        result.totals.device_models[result.data[i].mobile_device] = parseInt(result.data[i].visits);
                    } else {
                        result.totals.device_models[result.data[i].mobile_device] += parseInt(result.data[i].visits);
                    }
                }
            }

            if (_.startsWith(report.name, "language")) {
                result.totals.languages = {};
                for (var i=0; i<result.data.length; i++) {
                    if(typeof result.totals.languages[result.data[i].language] == "undefined") {
                        result.totals.languages[result.data[i].language] = parseInt(result.data[i].visits);
                    } else {
                        result.totals.languages[result.data[i].language] += parseInt(result.data[i].visits);
                    }
                }
            }


            if (_.startsWith(report.name, "devices")) {
                result.totals.devices = {mobile: 0, desktop: 0, tablet: 0};
                for (var i=0; i<result.data.length; i++)
                    result.totals.devices[result.data[i].device] += parseInt(result.data[i].visits);
            }

            if (report.name == "screen-size") {
                result.totals.screen_resolution = {};

                for (var i=0; i<result.data.length; i++) {
                    var screen_resolution = result.data[i].screen_resolution;
                    var visits = parseInt(result.data[i].visits);

                    if (!result.totals.screen_resolution[screen_resolution]) result.totals.screen_resolution[screen_resolution] = 0;
                    result.totals.screen_resolution[screen_resolution] += visits;
                }
            }

            if (report.name == "os") {

                result.totals.os = {};

                for (var i=0; i<result.data.length; i++) {
                    var os = result.data[i].os;
                    var visits = parseInt(result.data[i].visits);

                    if (!result.totals.os[os]) result.totals.os[os] = 0;
                    result.totals.os[os] += visits;
                }
            }

            if (report.name == "windows") {
                result.totals.os_version = {};

                for (var i=0; i<result.data.length; i++) {
                    var version = result.data[i].os_version;
                    var visits = parseInt(result.data[i].visits);

                    if (!result.totals.os_version[version]) result.totals.os_version[version] = 0;
                    result.totals.os_version[version] += visits;
                }
            }

            if (report.name == "browsers") {
                result.totals.browser = {};

                for (var i=0; i<result.data.length; i++) {
                    var browser = result.data[i].browser;
                    var visits = parseInt(result.data[i].visits);

                    if (!result.totals.browser[browser]) result.totals.browser[browser] = 0;
                    result.totals.browser[browser] += visits;
                }
            }

            if (report.name == "ie") {
                result.totals.ie_version = {};

                for (var i=0; i<result.data.length; i++) {
                    var version = result.data[i].browser_version;
                    var visits = parseInt(result.data[i].visits);

                    if (!result.totals.ie_version[version]) result.totals.ie_version[version] = 0;
                    result.totals.ie_version[version] += parseInt(result.data[i].visits);
                }
            }

            if (report.name == "os-browsers") {

                // Two two-level hashes.
                result.totals.by_os = {};
                result.totals.by_browsers = {};

                for (var i=0; i<result.data.length; i++) {
                    var os = result.data[i].os;
                    var browser = result.data[i].browser;
                    var visits = parseInt(result.data[i].visits)

                    if (!result.totals.by_os[os]) result.totals.by_os[os] = {};
                    if (!result.totals.by_os[os][browser]) result.totals.by_os[os][browser] = 0;

                    if (!result.totals.by_browsers[browser]) result.totals.by_browsers[browser] = {};
                    if (!result.totals.by_browsers[browser][os]) result.totals.by_browsers[browser][os] = 0;

                    result.totals.by_os[os][browser] += visits;
                    result.totals.by_browsers[browser][os] += visits;
                }
            }

            if (report.name == "windows-ie") {

                // Two two-level hashes.
                result.totals.by_windows = {};
                result.totals.by_ie = {};

                for (var i=0; i<result.data.length; i++) {
                    var windows = result.data[i].os_version;
                    var ie = result.data[i].browser_version;
                    var visits = parseInt(result.data[i].visits)

                    if (!result.totals.by_windows[windows]) result.totals.by_windows[windows] = {};
                    if (!result.totals.by_windows[windows][ie]) result.totals.by_windows[windows][ie] = 0;

                    if (!result.totals.by_ie[ie]) result.totals.by_ie[ie] = {};
                    if (!result.totals.by_ie[ie][windows]) result.totals.by_ie[ie][windows] = 0;

                    result.totals.by_windows[windows][ie] += visits;
                    result.totals.by_ie[ie][windows] += visits;
                }
            }

            if (report.name == "windows-browsers") {

                result.totals.by_windows = {};
                result.totals.by_browsers = {};

                for (var i=0; i<result.data.length; i++) {
                    var version = result.data[i].os_version;
                    var browser = result.data[i].browser;
                    var visits = parseInt(result.data[i].visits)

                    if (!result.totals.by_windows[version]) result.totals.by_windows[version] = {};
                    if (!result.totals.by_windows[version][browser]) result.totals.by_windows[version][browser] = 0;

                    if (!result.totals.by_browsers[browser]) result.totals.by_browsers[browser] = {};
                    if (!result.totals.by_browsers[browser][version]) result.totals.by_browsers[browser][version] = 0;

                    result.totals.by_windows[version][browser] += visits;
                    result.totals.by_browsers[browser][version] += visits;
                }
            }

            // presumably we're organizing these by date
            if ((result.data.length > 0) && (result.data[0].date)) {

                // At least one report (screen-size) gives back a bogus
                // first entry, for unknown reasons.
                if (result.data[0].date == "(other)")
                    result.totals.start_date = result.data[1].date;
                else
                    result.totals.start_date = result.data[0].date;

                result.totals.end_date = result.data[result.data.length-1].date;
            }
        }

        return result;
    }

};

module.exports = Analytics;
