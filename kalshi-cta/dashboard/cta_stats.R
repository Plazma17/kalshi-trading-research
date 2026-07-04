# cta_stats.R — base-R stats sidecar for the CTA Dashboard "analyze in R" buttons.
# NO external packages (jsonlite is NOT installed on this R): JSON is emitted by hand.
# Invoked as:  Rscript cta_stats.R <csvPath> <analysis> [p1]
#   analysis in {cor, lm, acf, kmeans, summary}
#   p1 = k (kmeans) or lag.max (acf); ignored otherwise.
# Reads a CSV whose columns are all numeric (renderer sends exactly the relevant slice).
# cor/lm use the first two columns; acf uses the first column; kmeans/summary use all numeric columns.
# Output: a single-line JSON object on stdout. On any failure: {"error":"..."} (still exit 0).

args <- commandArgs(trailingOnly = TRUE)
csv <- if (length(args) >= 1) args[1] else ""
analysis <- if (length(args) >= 2) args[2] else "summary"
p1 <- if (length(args) >= 3) suppressWarnings(as.numeric(args[3])) else NA

jnum <- function(x) {
  if (length(x) != 1) x <- x[1]
  if (is.null(x) || is.na(x) || !is.finite(x)) return("null")
  formatC(x, format = "g", digits = 10)
}
jstr <- function(s) {
  s <- as.character(s); if (length(s) != 1) s <- paste(s, collapse = " ")
  s <- gsub('\\', '\\\\', s, fixed = TRUE)   # escape backslash FIRST (Windows temp paths appear in read.csv error msgs)
  s <- gsub('"', '\\"', s, fixed = TRUE)      # then the double-quote
  s <- gsub('\r', '\\r', s, fixed = TRUE); s <- gsub('\n', '\\n', s, fixed = TRUE); s <- gsub('\t', '\\t', s, fixed = TRUE)
  paste0('"', s, '"')
}
fail <- function(msg) { cat(paste0('{"error":', jstr(msg), '}')); quit(save = "no", status = 0) }

d <- tryCatch(read.csv(csv, check.names = TRUE, stringsAsFactors = FALSE),
              error = function(e) fail(paste("read.csv:", conditionMessage(e))))
nummask <- sapply(d, is.numeric)
num <- d[, nummask, drop = FALSE]
if (ncol(num) < 1) fail("no numeric columns")

if (analysis == "cor") {
  if (ncol(num) < 2) fail("cor needs 2 numeric columns")
  x <- num[[1]]; y <- num[[2]]; ok <- is.finite(x) & is.finite(y); x <- x[ok]; y <- y[ok]
  if (length(x) < 3) fail("cor: <3 complete pairs")
  ct <- cor.test(x, y)
  cat(paste0('{"analysis":"cor","x":', jstr(names(num)[1]), ',"y":', jstr(names(num)[2]),
             ',"n":', length(x), ',"r":', jnum(unname(ct$estimate)), ',"p":', jnum(ct$p.value),
             ',"ci_lo":', jnum(ct$conf.int[1]), ',"ci_hi":', jnum(ct$conf.int[2]),
             ',"t":', jnum(unname(ct$statistic)), ',"df":', jnum(unname(ct$parameter)), '}'))
} else if (analysis == "lm") {
  if (ncol(num) < 2) fail("lm needs 2 numeric columns")
  x <- num[[1]]; y <- num[[2]]; ok <- is.finite(x) & is.finite(y); x <- x[ok]; y <- y[ok]
  if (length(x) < 3) fail("lm: <3 complete pairs")
  m <- lm(y ~ x); s <- summary(m); co <- s$coefficients
  slope <- if (nrow(co) >= 2) co[2, 1] else NA
  slope_p <- if (nrow(co) >= 2) co[2, 4] else NA
  f <- s$fstatistic
  fp <- if (!is.null(f)) pf(f[1], f[2], f[3], lower.tail = FALSE) else NA
  lo <- tryCatch(loess(y ~ x), error = function(e) NULL)
  lrsd <- if (!is.null(lo)) sd(residuals(lo)) else NA
  lspan <- if (!is.null(lo)) lo$pars$span else NA
  cat(paste0('{"analysis":"lm","x":', jstr(names(num)[1]), ',"y":', jstr(names(num)[2]),
             ',"n":', length(x), ',"intercept":', jnum(co[1, 1]), ',"slope":', jnum(slope),
             ',"r2":', jnum(s$r.squared), ',"adj_r2":', jnum(s$adj.r.squared),
             ',"slope_p":', jnum(slope_p), ',"model_p":', jnum(unname(fp)),
             ',"resid_sd":', jnum(s$sigma), ',"loess_resid_sd":', jnum(lrsd),
             ',"loess_span":', jnum(lspan), '}'))
} else if (analysis == "acf") {
  y <- num[[1]]; y <- y[is.finite(y)]
  if (length(y) < 5) fail("acf: <5 finite points")
  L <- if (is.finite(p1) && p1 >= 1) as.integer(p1) else 20
  a <- acf(y, plot = FALSE, lag.max = L)
  lg <- as.integer(a$lag[, 1, 1]); vv <- a$acf[, 1, 1]
  items <- paste0('{"lag":', lg, ',"acf":', sapply(vv, jnum), '}')
  cat(paste0('{"analysis":"acf","n":', length(y), ',"lag_max":', L,
             ',"lags":[', paste(items, collapse = ','), ']}'))
} else if (analysis == "kmeans") {
  k <- if (is.finite(p1) && p1 >= 2) as.integer(p1) else 3
  cc <- complete.cases(num)
  X <- num[cc, , drop = FALSE]
  keep <- sapply(X, function(c) sd(c) > 0)
  X <- X[, keep, drop = FALSE]
  if (nrow(X) < k || ncol(X) < 1) fail("kmeans: insufficient rows/variance")
  Z <- scale(X); set.seed(42)
  km <- kmeans(Z, centers = k, nstart = 10, iter.max = 50)
  cent <- aggregate(X, list(cluster = km$cluster), mean)
  colobjs <- character(0)
  for (ci in seq_len(nrow(cent))) {
    kv <- character(0)
    for (cn in names(X)) kv <- c(kv, paste0(jstr(cn), ':', jnum(cent[ci, cn])))
    colobjs <- c(colobjs, paste0('{"cluster":', cent$cluster[ci], ',"means":{', paste(kv, collapse = ','), '}}'))
  }
  cat(paste0('{"analysis":"kmeans","k":', k, ',"n":', nrow(X), ',"cols":[',
             paste(sapply(names(X), jstr), collapse = ','), '],"sizes":[',
             paste(km$size, collapse = ','), ']',
             ',"tot_withinss":', jnum(km$tot.withinss), ',"betweenss":', jnum(km$betweenss),
             ',"totss":', jnum(km$totss), ',"centers":[', paste(colobjs, collapse = ','), ']}'))
} else {
  cols <- character(0)
  for (cn in names(num)) {
    x <- num[[cn]]; x <- x[is.finite(x)]
    if (length(x) < 1) { cols <- c(cols, paste0('{"name":', jstr(cn), ',"n":0}')); next }
    m <- mean(x); s <- sd(x); q <- quantile(x, c(0, .25, .5, .75, 1))
    skew <- if (is.finite(s) && s > 0) mean(((x - m) / s)^3) else NA
    kurt <- if (is.finite(s) && s > 0) mean(((x - m) / s)^4) - 3 else NA
    cols <- c(cols, paste0('{"name":', jstr(cn), ',"n":', length(x),
                           ',"mean":', jnum(m), ',"sd":', jnum(s), ',"min":', jnum(q[1]),
                           ',"q1":', jnum(q[2]), ',"median":', jnum(q[3]), ',"q3":', jnum(q[4]),
                           ',"max":', jnum(q[5]), ',"skew":', jnum(skew), ',"kurt":', jnum(kurt), '}'))
  }
  cat(paste0('{"analysis":"summary","n":', nrow(num), ',"columns":[', paste(cols, collapse = ','), ']}'))
}
