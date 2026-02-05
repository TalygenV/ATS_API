const express = require('express');
const { query, queryOne } = require('../config/database');
const { authenticate, requireWriteAccess } = require('../middleware/auth');

const router = express.Router();

// All analytics routes require authentication and HR/Admin access
router.use(authenticate);
router.use(requireWriteAccess);

// Job-wise Hiring Performance
router.get('/positions', async (req, res) => {
  try {
    const positions = await query(`
      SELECT 
        jd.title,
        COUNT(ce.id) AS total_candidates,
        SUM(ce.hr_final_status='selected') AS hired,
        AVG(ce.overall_match) AS avg_match
      FROM job_descriptions jd
      LEFT JOIN candidate_evaluations ce ON ce.job_description_id = jd.id
      GROUP BY jd.id, jd.title
      ORDER BY total_candidates DESC
    `);

    res.json({
      success: true,
      data: positions.map(pos => ({
        title: pos.title,
        total_candidates: parseInt(pos.total_candidates) || 0,
        hired: parseInt(pos.hired) || 0,
        avg_match: parseFloat(pos.avg_match) || 0
      }))
    });
  } catch (error) {
    console.error('Error fetching positions analytics:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch positions analytics',
      message: error.message
    });
  }
});

// Hiring Funnel (HR Final Status Distribution)
router.get('/hiring-funnel', async (req, res) => {
  try {
    const funnel = await query(`
      SELECT 
        COALESCE(hr_final_status, 'pending') AS hr_final_status,
        COUNT(*) AS count
      FROM candidate_evaluations
      GROUP BY hr_final_status
    `);

    const result = {
      pending: 0,
      rejected: 0,
      selected: 0,
      on_hold: 0
    };

    funnel.forEach(item => {
      const status = item.hr_final_status || 'pending';
      result[status] = parseInt(item.count) || 0;
    });

    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    console.error('Error fetching hiring funnel:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch hiring funnel',
      message: error.message
    });
  }
});

// Time to Hire (Average Days to Decision)
router.get('/time-to-hire', async (req, res) => {
  try {
    const timeToHire = await query(`
      SELECT 
        jd.title,
        AVG(TIMESTAMPDIFF(DAY, ce.created_at, ce.updated_at)) AS avg_days_to_decision
      FROM candidate_evaluations ce
      JOIN job_descriptions jd ON jd.id = ce.job_description_id
      WHERE ce.hr_final_status != 'pending' AND ce.hr_final_status IS NOT NULL
      GROUP BY jd.id, jd.title
      ORDER BY avg_days_to_decision DESC
    `);

    res.json({
      success: true,
      data: timeToHire.map(item => ({
        title: item.title,
        avg_days: parseFloat(item.avg_days_to_decision) || 0
      }))
    });
  } catch (error) {
    console.error('Error fetching time to hire:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch time to hire',
      message: error.message
    });
  }
});

// Rejection Reason Trends
router.get('/rejection-reasons', async (req, res) => {
  try {
    const reasons = await query(`
      SELECT 
        COALESCE(hr_final_reason, 'Not specified') AS hr_final_reason,
        COUNT(*) AS count
      FROM candidate_evaluations
      WHERE hr_final_status='rejected'
      GROUP BY hr_final_reason
      ORDER BY count DESC
    `);

    const result = {};
    reasons.forEach(item => {
      result[item.hr_final_reason] = parseInt(item.count) || 0;
    });

    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    console.error('Error fetching rejection reasons:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch rejection reasons',
      message: error.message
    });
  }
});

// Interviewer Load (Interviews Taken)
router.get('/interviewers', async (req, res) => {
  try {
    const interviewers = await query(`
      SELECT 
        u.full_name,
        COUNT(id.id) AS interviews_taken
      FROM interview_details id
      JOIN users u ON u.id = id.interviewer_id
      GROUP BY id.interviewer_id, u.full_name
      ORDER BY interviews_taken DESC
    `);

    res.json({
      success: true,
      data: interviewers.map(item => ({
        full_name: item.full_name,
        interviews_taken: parseInt(item.interviews_taken) || 0
      }))
    });
  } catch (error) {
    console.error('Error fetching interviewers analytics:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch interviewers analytics',
      message: error.message
    });
  }
});

// Feedback Outcome Ratio (Interviewer Status)
router.get('/interviewer-status', async (req, res) => {
  try {
    const statuses = await query(`
      SELECT 
        COALESCE(interviewer_status, 'pending') AS interviewer_status,
        COUNT(*) AS count
      FROM interview_details
      GROUP BY interviewer_status
    `);

    const result = {
      pending: 0,
      selected: 0,
      rejected: 0,
      on_hold: 0
    };

    statuses.forEach(item => {
      const status = item.interviewer_status || 'pending';
      result[status] = parseInt(item.count) || 0;
    });

    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    console.error('Error fetching interviewer status:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch interviewer status',
      message: error.message
    });
  }
});

// Slot Utilization
router.get('/slot-utilization', async (req, res) => {
  try {
    const utilization = await query(`
      SELECT 
        interviewer_id,
        COUNT(*) AS total_slots,
        SUM(is_booked=1) AS booked_slots,
        ROUND(SUM(is_booked=1)/COUNT(*)*100,2) AS utilization_pct
      FROM interviewer_time_slots
      GROUP BY interviewer_id
      ORDER BY utilization_pct DESC
    `);

    res.json({
      success: true,
      data: utilization.map(item => ({
        interviewer_id: item.interviewer_id,
        total_slots: parseInt(item.total_slots) || 0,
        booked_slots: parseInt(item.booked_slots) || 0,
        utilization_pct: parseFloat(item.utilization_pct) || 0
      }))
    });
  } catch (error) {
    console.error('Error fetching slot utilization:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch slot utilization',
      message: error.message
    });
  }
});

// Resume Volume Over Time
router.get('/resume-volume', async (req, res) => {
  try {
    const { group_by = 'month' } = req.query;
    
    // Validate group_by parameter
    const validGroupBy = ['day', 'week', 'month', 'quarter', 'year'];
    const groupByValue = validGroupBy.includes(group_by) ? group_by : 'month';

    let sql = '';
    switch (groupByValue) {
      case 'day':
        sql = `SELECT DATE(created_at) AS period, COUNT(*) AS resumes_uploaded
               FROM resumes WHERE parent_id IS NULL
               GROUP BY period ORDER BY period ASC`;
        break;
      case 'week':
        sql = `SELECT DATE_FORMAT(created_at, '%Y-%u') AS period, COUNT(*) AS resumes_uploaded
               FROM resumes WHERE parent_id IS NULL
               GROUP BY period ORDER BY period ASC`;
        break;
      case 'month':
        sql = `SELECT DATE_FORMAT(created_at, '%Y-%m') AS period, COUNT(*) AS resumes_uploaded
               FROM resumes WHERE parent_id IS NULL
               GROUP BY period ORDER BY period ASC`;
        break;
      case 'quarter':
        sql = `SELECT CONCAT(YEAR(created_at), '-Q', QUARTER(created_at)) AS period, COUNT(*) AS resumes_uploaded
               FROM resumes WHERE parent_id IS NULL
               GROUP BY period ORDER BY period ASC`;
        break;
      case 'year':
        sql = `SELECT YEAR(created_at) AS period, COUNT(*) AS resumes_uploaded
               FROM resumes WHERE parent_id IS NULL
               GROUP BY period ORDER BY period ASC`;
        break;
      default:
        sql = `SELECT DATE_FORMAT(created_at, '%Y-%m') AS period, COUNT(*) AS resumes_uploaded
               FROM resumes WHERE parent_id IS NULL
               GROUP BY period ORDER BY period ASC`;
    }
    
    const resumes = await query(sql);

    res.json({
      success: true,
      data: resumes.map(item => ({
        period: item.period.toString(),
        resumes_uploaded: parseInt(item.resumes_uploaded) || 0
      }))
    });
  } catch (error) {
    console.error('Error fetching resume volume:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch resume volume',
      message: error.message
    });
  }
});

// Parsed vs Interview Assignment Status
router.get('/process-metrics', async (req, res) => {
  try {
    const metrics = await queryOne(`
      SELECT
        COUNT(DISTINCT ce.id) AS total_parsed_resumes,
        COUNT(DISTINCT id.candidate_evaluations_id) AS interviews_assigned,
        COUNT(DISTINCT CASE  WHEN ce.hr_final_status = 'selected' THEN ce.id END) AS total_hired,
        COUNT(DISTINCT ce.id) - COUNT(DISTINCT id.candidate_evaluations_id) AS interviews_not_assigned
      FROM candidate_evaluations ce
      LEFT JOIN interview_details id ON id.candidate_evaluations_id = ce.id
    `);

    res.json({
      success: true,
      data: {
        total_parsed_resumes: parseInt(metrics.total_parsed_resumes) || 0,
        interviews_assigned: parseInt(metrics.interviews_assigned) || 0,
        interviews_not_assigned: parseInt(metrics.interviews_not_assigned) || 0
      }
    });
  } catch (error) {
    console.error('Error fetching process metrics:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch process metrics',
      message: error.message
    });
  }
});

// Helper function to build date filter WHERE clause
const buildDateFilter = (fromDate, toDate, tableAlias = '') => {
  if (!fromDate && !toDate) return '';
  
  const prefix = tableAlias ? `${tableAlias}.` : '';
  let filter = '';
  
  if (fromDate && toDate) {
    filter = `WHERE ${prefix}created_at BETWEEN ? AND ?`;
  } else if (fromDate) {
    filter = `WHERE ${prefix}created_at >= ?`;
  } else if (toDate) {
    filter = `WHERE ${prefix}created_at <= ?`;
  }
  
  return filter;
};

// Helper function to append date filter to existing WHERE clause
const appendDateFilter = (fromDate, toDate, tableAlias = '') => {
  if (!fromDate && !toDate) return '';
  
  const prefix = tableAlias ? `${tableAlias}.` : '';
  let filter = '';
  
  if (fromDate && toDate) {
    filter = `AND ${prefix}created_at BETWEEN ? AND ?`;
  } else if (fromDate) {
    filter = `AND ${prefix}created_at >= ?`;
  } else if (toDate) {
    filter = `AND ${prefix}created_at <= ?`;
  }
  
  return filter;
};

// Helper function to get date filter params
const getDateFilterParams = (fromDate, toDate) => {
  const params = [];
  if (fromDate && toDate) {
    params.push(fromDate + ' 00:00:00', toDate + ' 23:59:59');
  } else if (fromDate) {
    params.push(fromDate + ' 00:00:00');
  } else if (toDate) {
    params.push(toDate + ' 23:59:59');
  }
  return params;
};

// Get all analytics data in one call (for dashboard initialization)
router.get('/dashboard', async (req, res) => {
  try {
    const { from_date, to_date } = req.query;
    
    // Build date filter conditions
    // Note: interview_details doesn't have created_at, so we'll join with interviewer_time_slots
    const dateFilterCE = buildDateFilter(from_date, to_date, 'ce');
    const dateFilterR = buildDateFilter(from_date, to_date, 'r');
    const dateFilterITS = buildDateFilter(from_date, to_date, 'its');
    const hasDateRange = from_date && to_date;
    // For interview_details queries, we need to join with interviewer_time_slots
    const needsInterviewDetailsJoin = from_date || to_date;
    const interviewDetailsDateFilter = needsInterviewDetailsJoin 
      ? appendDateFilter(from_date, to_date, 'its').replace('AND', 'WHERE')
      : '';
    
    const dateParams = getDateFilterParams(from_date, to_date);
    
    // Fetch all analytics data in parallel
    const [
      rejectionMoreDetailsResult,
      positionsResult,
      hiringFunnelResult,
      timeToHireResult,
      rejectionReasonsResult,
      interviewersResult,
      interviewerStatusResult,
      slotUtilizationResult,
      resumeVolumeResult,
      processMetricsResult,
      rejectedMetricsResult,
      growthStats,
      recruitmentProcessMetricsKpi,
      jobDescIndustryAvg
    ] = await Promise.all([
      
      queryOne(`
SELECT
    SUM(CASE WHEN rejection_type = 'Rejected by Resume Parsing' THEN 1 ELSE 0 END) AS rejected_by_resume_parsing,
    SUM(CASE WHEN rejection_type = 'Technical Rejected' THEN 1 ELSE 0 END) AS technical_rejected,
    SUM(CASE WHEN rejection_type = 'Rejected by Interviewer' THEN 1 ELSE 0 END) AS rejected_by_interviewer,
    SUM(CASE WHEN rejection_type = 'Position on Hold' THEN 1 ELSE 0 END) AS position_on_hold,
    SUM(CASE WHEN rejection_type = 'Rejected by HR' THEN 1 ELSE 0 END) AS rejected_by_hr
FROM (
    SELECT
        CASE 
            WHEN ce.status = 'rejected' 
                THEN 'Rejected by Resume Parsing'

            WHEN LOWER(ce.hr_final_reason) LIKE '%technical%' 
                THEN 'Technical Rejected'

            WHEN LOWER(ce.hr_final_reason) LIKE '%interviewer%' 
                THEN 'Rejected by Interviewer'

            WHEN LOWER(ce.hr_final_reason) LIKE '%hold%' 
                 OR ce.hr_final_status = 'on_hold'
                THEN 'Position on Hold'

            WHEN ce.hr_final_status = 'rejected' 
                THEN 'Rejected by HR'

        END AS rejection_type

    FROM candidate_evaluations ce
 ${dateFilterCE || ''} 
) rejectionlist ;


  
`, dateParams),


      query(`
        SELECT 
          jd.title,
          COUNT(ce.id) AS total_candidates,
          SUM(ce.hr_final_status='selected') AS hired,
          AVG(ce.overall_match) AS avg_match
        FROM job_descriptions jd
        LEFT JOIN candidate_evaluations ce ON ce.job_description_id = jd.id
        ${dateFilterCE || ''}
        GROUP BY jd.id, jd.title
        ORDER BY total_candidates DESC
      `, dateParams),
      query(`
        SELECT 
          COALESCE(hr_final_status, 'pending') AS hr_final_status,
          COUNT(*) AS count
        FROM candidate_evaluations ce
        ${dateFilterCE || ''}
        GROUP BY hr_final_status
      `, dateParams),
      query(`
        SELECT 
          jd.title,
          ROUND(AVG(TIMESTAMPDIFF(DAY, ce.created_at, ce.updated_at))) AS avg_days_to_decision
        FROM candidate_evaluations ce
        JOIN job_descriptions jd ON jd.id = ce.job_description_id
        WHERE ce.hr_final_status != 'pending' AND ce.hr_final_status IS NOT NULL
        ${appendDateFilter(from_date, to_date, 'ce')}
        GROUP BY jd.id, jd.title
        ORDER BY avg_days_to_decision DESC
      `, dateParams),
      query(`
        SELECT 
          COALESCE(hr_final_reason, 'Not specified') AS hr_final_reason,
          COUNT(*) AS count
        FROM candidate_evaluations ce
        WHERE hr_final_status='rejected'
        ${appendDateFilter(from_date, to_date, 'ce')}
        GROUP BY hr_final_reason
        ORDER BY count DESC
      `, dateParams),
      query(`
        SELECT 
          u.full_name,
          COUNT(id.id) AS interviews_taken
        FROM interview_details id
        JOIN users u ON u.id = id.interviewer_id
        ${needsInterviewDetailsJoin ? 'INNER JOIN interviewer_time_slots its ON id.interviewer_time_slots_id = its.id' : ''}
        ${interviewDetailsDateFilter}
        GROUP BY id.interviewer_id, u.full_name
        ORDER BY interviews_taken DESC
      `, dateParams),
      queryOne(`
        SELECT
          SUM(CASE WHEN s.interviewer_status = 'pending'  THEN s.count ELSE 0 END) AS pending,
          SUM(CASE WHEN s.interviewer_status = 'selected' THEN s.count ELSE 0 END) AS selected,
          SUM(CASE WHEN s.interviewer_status = 'rejected' THEN s.count ELSE 0 END) AS rejected,
          SUM(CASE WHEN s.interviewer_status = 'on_hold'  THEN s.count ELSE 0 END) AS on_hold,
          MAX(stats.total_parsed_resumes)     AS total_parsed_resumes,
          MAX(stats.interviews_assigned)      AS interviews_assigned,
          MAX(stats.interviews_not_assigned)  AS interviews_not_assigned
        FROM (
          SELECT 
            COALESCE(id.interviewer_status, 'pending') AS interviewer_status,
            COUNT(*) AS count
          FROM interview_details id
          ${needsInterviewDetailsJoin ? 'INNER JOIN interviewer_time_slots its ON id.interviewer_time_slots_id = its.id' : ''}
          ${interviewDetailsDateFilter}
          GROUP BY COALESCE(id.interviewer_status, 'pending')
        ) s
        CROSS JOIN (
          SELECT
            COUNT(DISTINCT ce.id) AS total_parsed_resumes,
            COUNT(DISTINCT id.candidate_evaluations_id) AS interviews_assigned,
            COUNT(DISTINCT ce.id) - COUNT(DISTINCT id.candidate_evaluations_id) AS interviews_not_assigned,
            COUNT(DISTINCT CASE  WHEN ce.hr_final_status = 'selected' THEN ce.id END) AS total_hired
          FROM candidate_evaluations ce
          LEFT JOIN interview_details id ON id.candidate_evaluations_id = ce.id
          ${dateFilterCE || ''}
        ) stats
      `, [...dateParams, ...dateParams]),
      query(`
        SELECT 
          u.full_name as interviewer_id,
          COUNT(*) AS total_slots,
          SUM(is_booked=1) AS booked_slots,
          ROUND(SUM(is_booked=1)/COUNT(*)*100,2) AS utilization_pct
        FROM interviewer_time_slots its 
        JOIN users u ON u.id = its.interviewer_id
        ${dateFilterITS || ''}
        GROUP BY interviewer_id
        ORDER BY utilization_pct DESC
      `, dateParams),
      query(`
        SELECT 
          DATE_FORMAT(created_at, '%Y-%m') AS period,
          COUNT(*) AS resumes_uploaded
        FROM resumes r
        WHERE parent_id IS NULL
        ${appendDateFilter(from_date, to_date, 'r')}
        GROUP BY period
        ORDER BY period ASC
      `, dateParams),
      queryOne(`
        SELECT
          COUNT(DISTINCT ce.id) AS total_parsed_resumes,
          COUNT(DISTINCT id.candidate_evaluations_id) AS interviews_assigned,
          COUNT(DISTINCT CASE  WHEN ce.hr_final_status = 'selected' THEN ce.id END) AS total_hired,
          COUNT(DISTINCT ce.id) - COUNT(DISTINCT id.candidate_evaluations_id) AS interviews_not_assigned
        FROM candidate_evaluations ce
        LEFT JOIN interview_details id ON id.candidate_evaluations_id = ce.id
        ${dateFilterCE || ''}
      `, dateParams),
      queryOne(`
        SELECT
           COUNT(DISTINCT CASE  WHEN ce.status = 'rejected' THEN ce.id END) AS total_parse_rejected,
          COUNT(DISTINCT CASE  WHEN ce.hr_final_status = 'rejected' THEN ce.id END) AS total_hr_rejected,
          COUNT(DISTINCT CASE  WHEN id.interviewer_status = 'rejected' THEN ce.id END)  AS total_interviewer_rejected
        FROM candidate_evaluations ce
        LEFT JOIN interview_details id ON id.candidate_evaluations_id = ce.id
        ${dateFilterCE || ''}
      `, dateParams),
      hasDateRange ? queryOne(`
        WITH current AS (
          SELECT
            COUNT(*) AS total_candidates,
            SUM(ce.hr_final_status='selected') AS hired_candidates,
            AVG(ce.overall_match) AS avg_match_score,
            COUNT(*) AS interviews_conducted
          FROM candidate_evaluations ce
          WHERE ce.created_at BETWEEN ? AND ?
        ),
        previous AS (
          SELECT
            COUNT(*) AS total_candidates_prev,
            SUM(ce.hr_final_status='selected') AS hired_candidates_prev,
            AVG(ce.overall_match) AS avg_match_score_prev,
            COUNT(*) AS interviews_conducted_prev
          FROM candidate_evaluations ce
          WHERE ce.created_at BETWEEN
            DATE_SUB(?, INTERVAL DATEDIFF(?, ?) + 1 DAY)
            AND DATE_SUB(?, INTERVAL 1 DAY)
        )
        SELECT
          *,
          CASE WHEN total_candidates_prev = 0 THEN NULL ELSE ROUND(((total_candidates - total_candidates_prev)/total_candidates_prev)*100,2) END AS total_candidates_growth_pct,
          CASE WHEN hired_candidates_prev = 0 THEN NULL ELSE ROUND(((hired_candidates - hired_candidates_prev)/hired_candidates_prev)*100,2) END AS hired_candidates_growth_pct,
          CASE WHEN avg_match_score_prev IS NULL OR avg_match_score_prev = 0 THEN NULL ELSE ROUND(((avg_match_score - avg_match_score_prev)/avg_match_score_prev)*100,2) END AS avg_match_score_growth_pct,
          CASE WHEN interviews_conducted_prev = 0 THEN NULL ELSE ROUND(((interviews_conducted - interviews_conducted_prev)/interviews_conducted_prev)*100,2) END AS interviews_conducted_growth_pct
        FROM current, previous
      `, [
        from_date, to_date,
        from_date, to_date, from_date, from_date
      ]) : null,
      query(`SELECT  * FROM processmetricstarget where status = 'active' ORDER BY id desc Limit 1`),
      query(`SELECT id, title,status,industryAvg FROM job_descriptions`)
    ]);

    // Process hiring funnel
    const hiringFunnel = {
      pending: 0,
      rejected: 0,
      selected: 0,
      on_hold: 0
    };
    hiringFunnelResult.forEach(item => {
      hiringFunnel[item.hr_final_status] = parseInt(item.count) || 0;
    });

    // Process rejection reasons
    const rejectionReasons = {};
    rejectionReasonsResult.forEach(item => {
      rejectionReasons[item.hr_final_reason] = parseInt(item.count) || 0;
    });

    // Process interviewer status (single row from combined query)
    const interviewerStatus = {
      pending: 0,
      selected: 0,
      rejected: 0,
      on_hold: 0,
      total_parsed_resumes: 0,
      //interviews_assigned: 0,
      interviews_not_assigned: 0
    };
    if (interviewerStatusResult) {
      interviewerStatus.pending = parseInt(interviewerStatusResult.pending) || 0;
      interviewerStatus.selected = parseInt(interviewerStatusResult.selected) || 0;
      interviewerStatus.rejected = parseInt(interviewerStatusResult.rejected) || 0;
      interviewerStatus.on_hold = parseInt(interviewerStatusResult.on_hold) || 0;
      interviewerStatus.total_parsed_resumes = parseInt(interviewerStatusResult.total_parsed_resumes) || 0;
     // interviewerStatus.interviews_assigned = parseInt(interviewerStatusResult.interviews_assigned) || 0;
      interviewerStatus.interviews_not_assigned = (parseInt(interviewerStatusResult.total_parsed_resumes) - (parseInt(interviewerStatusResult.pending)+parseInt(interviewerStatusResult.selected)+parseInt(interviewerStatusResult.rejected)+parseInt(interviewerStatusResult.on_hold))) || 0;
    }

    res.json({
      success: true,
      data: {
        positions: positionsResult.map(pos => ({
          title: pos.title,
          total_candidates: parseInt(pos.total_candidates) || 0,
          hired: parseInt(pos.hired) || 0,
          avg_match: parseFloat(pos.avg_match) || 0
        })),
        hiringFunnel,
        timeToHire: timeToHireResult.map(item => ({
          title: item.title,
          avg_days: parseFloat(item.avg_days_to_decision) || 0
        })),
        rejectionReasons,
        interviewers: interviewersResult.map(item => ({
          full_name: item.full_name,
          interviews_taken: parseInt(item.interviews_taken) || 0
        })),
        interviewerStatus,
        slotUtilization: slotUtilizationResult.map(item => ({
          interviewer_id: item.interviewer_id,
          total_slots: parseInt(item.total_slots) || 0,
          booked_slots: parseInt(item.booked_slots) || 0,
          utilization_pct: parseFloat(item.utilization_pct) || 0
        })),
        resumeVolume: resumeVolumeResult.map(item => ({
          period: item.period.toString(),
          resumes_uploaded: parseInt(item.resumes_uploaded) || 0
        })),
        processMetrics: {
          total_parsed_resumes: parseInt(processMetricsResult.total_parsed_resumes) || 0,
          interviews_assigned: parseInt(processMetricsResult.interviews_assigned) || 0,
          interviews_not_assigned: parseInt(processMetricsResult.interviews_not_assigned) || 0,
          total_hired : parseInt(processMetricsResult.total_hired) || 0
        },
        rejectedMetricsResult ,
        rejectionMoreDetailsResult : {
          rejected_by_resume_parsing: parseInt(rejectionMoreDetailsResult.rejected_by_resume_parsing) || 0,
          technical_rejected: parseInt(rejectionMoreDetailsResult.technical_rejected) || 0,
          rejected_by_interviewer: parseInt(rejectionMoreDetailsResult.rejected_by_interviewer) || 0,
          position_on_hold: parseInt(rejectionMoreDetailsResult.position_on_hold) || 0,
          rejected_by_hr: parseInt(rejectionMoreDetailsResult.rejected_by_hr) || 0
        },
        growthStats: growthStats || {},
        recruitmentProcessMetricsKpi : recruitmentProcessMetricsKpi || {},
        jobDescIndustryAvg :jobDescIndustryAvg ||{}
      }
    });
  } catch (error) {
    console.error('Error fetching dashboard analytics:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch dashboard analytics',
      message: error.message
    });
  }
});

module.exports = router;
