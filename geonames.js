var fs = require('fs');
var path = require('path');
var request = require('request');
var yauzl = require('yauzl');
var H = require('highland');
var R = require('ramda');

// GeoNames configuration
var baseUrl = 'http://download.geonames.org/export/dump/';
var baseUri = 'http://sws.geonames.org/';
var allCountries = 'allCountries.zip';

var adminCodesFiles = [
  {
    key: 'admin1',
    filename: 'admin1CodesASCII.txt'
  },
  {
    key: 'admin2',
    filename: 'admin2Codes.txt'
  }
];

var allCountriesColumns = [
  'geonameid',
  'name',
  'asciiname',
  'alternatenames',
  'latitude',
  'longitude',
  'featureClass',
  'featureCode',
  'countryCode',
  'cc2',
  'admin1Code',
  'admin2Code',
  'admin3Code',
  'admin4Code',
  'population',
  'elevation',
  'dem',
  'timezone',
  'modificationDate'
];

var adminCodeColumns = [
  'code',
  'name',
  'asciiname',
  'geonameid'
];

var adminKeys = [
  'countryCode',
  'admin1Code',
  'admin2Code',
  'admin3Code',
  'admin4Code'
];

function downloadGeoNamesFile(dir, filename, callback) {
  request
    .get(baseUrl + filename)
    .pipe(fs.createWriteStream(path.join(dir, filename)))
    .on('error', function(err) {
      callback(err);
    })
    .on('finish', function() {
      callback();
    });
}

function readAdminCodes(path, adminCodes, callback) {
  H(fs.createReadStream(path))
    .split()
    .compact()
    .map(R.split('\t'))
    .map(R.zipObj(adminCodeColumns))
    .each(function(obj) {
      adminCodes[obj.code] = obj;
    })
    .errors(function(err) {
      callback(err);
    })
    .done(function() {
      callback();
    });
}

function getAdminCodes(config, dir, callback) {
  var adminCodes = {
    admin1: {},
    admin2: {}
  };

  H(adminCodesFiles)
    .map(function(adminCodeFile) {
      return H.curry(readAdminCodes, path.join(dir, adminCodeFile.filename), adminCodes[adminCodeFile.key]);
    })
    .nfcall([])
    .parallel(2)
    .errors(function(err) {
      callback(err);
    })
    .done(function() {
      callback(null, adminCodes);
    });
}

function getRelations(config, adminCodes, obj) {
  var relations = [];

  var codes = R.filter(R.identity, R.values(R.pick(adminKeys, obj)));
  if (codes.length === 3) {
    var parentObj = adminCodes.admin2[codes.join('.')];

    if (obj.geonameid === parentObj.geonameid) {
      parentObj = adminCodes.admin1[codes.slice(0, 2).join('.')];
    }

    relations = [
      {
        from: baseUri + obj.geonameid,
        to: baseUri + parentObj.geonameid,
        type: config.relations.liesIn
      }
    ];
  }

  // TODO: add support for admin1 -> country relations!

  return relations;
}

function process(config, writer, row, adminCodes, callback) {
  var type;
  var featureCode = row.featureCode;

  while (featureCode.length > 0 && !type) {
    type = config.types[featureCode];
    featureCode = featureCode.slice(0, -1);
  }

  if (type) {
    var data = [];

    var pit = {
      uri: baseUri + row.geonameid,
      name: row.name,
      type: type,
      geometry: {
        type: 'Point',
        coordinates: [
          parseFloat(row.longitude),
          parseFloat(row.latitude)
        ]
      },
      data: {
        featureClass: row.featureClass,
        featureCode: row.featureCode,
        countryCode: row.countryCode,
        cc2: row.cc2,
        admin1Code: row.admin1Code,
        admin2Code: row.admin2Code,
        admin3Code: row.admin3Code,
        admin4Code: row.admin4Code
      }
    };

    data.push({
      type: 'pit',
      obj: pit
    });

    data = data.concat(getRelations(config, adminCodes, row).map(function(relation) {
      return {
        type: 'relation',
        obj: relation
      };
    }));

    writer.writeObjects(data, function(err) {
      callback(err);
    });
  } else {
    callback();
  }
}

function filterRow(filter, row, extraUris) {
  return R.whereEq(filter, row) || extraUris[row.geonameid];
}

function download(config, dir, writer, callback) {
  var adminCodesFilenames = adminCodesFiles.map(function(c) {
    return c.filename;
  });

  H([
    allCountries,
    adminCodesFilenames
  ])
    .flatten()
    .map(H.curry(downloadGeoNamesFile, dir))
    .nfcall([])
    .series()
    .done(function() {
      yauzl.open(path.join(dir, allCountries), {lazyEntries: true}, function(err, zipfile) {
        if (err) {
          throw err;
        }

        zipfile.readEntry();
        zipfile.on('entry', function(entry) {
          var allCountriesTxt = allCountries.replace('zip', 'txt');
          if (entry.fileName === allCountriesTxt) {
            zipfile.openReadStream(entry, function(err, readStream) {
              if (err) {
                throw err;
              }

              readStream
                .pipe(fs.createWriteStream(path.join(dir, allCountriesTxt)))
                .on('end', function() {
                  callback();
                });
            });
          }
        });
      });
    });
}

function convert(config, dir, writer, callback) {
  getAdminCodes(config, dir, function(err, adminCodes) {
    if (err) {
      callback(err);
    } else {
      var filename = path.join(dir, 'allCountries.txt');

      var extraUris = {};
      (config.extraUris ? require(config.extraUris) : []).forEach(function(uri) {
        var id = uri.replace('http://sws.geonames.org/', '');
        extraUris[id] = true;
      });

      H(fs.createReadStream(filename, {encoding: 'utf8'}))
        .split()
        .map(R.split('\t'))
        .map(R.zipObj(allCountriesColumns))
        .filter(function(row) {
          return R.flip(R.any)(config.filters)(R.curry(filterRow)(R.__, row, extraUris));
        })
        .map(function(row) {
          return H.curry(process, config, writer, row, adminCodes);
        })
        .nfcall([])
        .series()
        .errors(function(err) {
          callback(err);
        })
        .done(function() {
          callback();
        });
    }
  });
}

// ==================================== API ====================================

module.exports.title = 'GeoNames';
module.exports.url = 'http://www.geonames.org/';

module.exports.steps = [
  download,
  convert
];
