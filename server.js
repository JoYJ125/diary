require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());

// Supabase 클라이언트 생성 (DB 커넥션 연결 없이 API 키 기반 연동)
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// KST 오늘 날짜 (YYYY-MM-DD)
const getKSTDateString = () => {
  const now = new Date();
  const kst = new Date(now.getTime() + (9 * 60 * 60 * 1000));
  return kst.toISOString().split('T')[0];
};

// 1. 할 일 신규 등록 API (Supabase DB에 행 추가)
app.post('/api/todos', async (req, res) => {
  const { plan_id = 1, content, due_date, priority = 'MEDIUM', tags = '', estimated_hours = 0 } = req.body;

  if (!content) {
    return res.status(400).json({ error: '할 일 내용을 입력해주세요.' });
  }

  try {
    // todos 테이블에 할 일 추가
    const { data, error } = await supabase
      .from('todos')
      .insert([
        {
          plan_id,
          content,
          status: 'IN_PROGRESS',
          due_date: due_date || null,
          priority,
          tags,
          estimated_hours
        }
      ])
      .select();

    if (error) throw error;

    res.status(201).json(data[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. TODO 목록 조회 API
app.get('/api/todos', async (req, res) => {
  const { plan_id = 1, search, status, filter_type, sort_by = 'due_date' } = req.query;
  const kstToday = getKSTDateString();

  try {
    let query = supabase
      .from('todos')
      .select('*, execution_logs(actual_hours, obstacle_reason)')
      .eq('plan_id', plan_id);

    if (search) {
      query = query.or(`content.ilike.%${search}%,tags.ilike.%${search}%`);
    }

    if (status && status !== 'ALL') {
      query = query.eq('status', status);
    }

    if (filter_type === 'DELAYED') {
      query = query.neq('status', 'COMPLETED').lt('due_date', kstToday);
    }

    const allowedSortCols = ['due_date', 'priority', 'estimated_hours'];
    const orderCol = allowedSortCols.includes(sort_by) ? sort_by : 'due_date';
    query = query.order(orderCol, { ascending: true });

    const { data, error } = await query;
    if (error) throw error;

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. 할 일 완료 처리 API
app.post('/api/todos/:id/complete', async (req, res) => {
  const todoId = req.params.id;
  const { actual_hours = 0, obstacle_reason = null } = req.body;

  try {
    // 1) 상태 업데이트
    const { error: todoError } = await supabase
      .from('todos')
      .update({ status: 'COMPLETED' })
      .eq('id', todoId);

    if (todoError) throw todoError;

    // 2) 실행 로그 추가
    const { error: logError } = await supabase
      .from('execution_logs')
      .insert([
        {
          todo_id: todoId,
          start_time: new Date().toISOString(),
          end_time: new Date().toISOString(),
          actual_hours,
          obstacle_reason
        }
      ]);

    if (logError) throw logError;

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. SEE 돌아보기 집계 요약 API
app.get('/api/plans/:id/review-summary', async (req, res) => {
  const planId = req.params.id;
  const kstToday = getKSTDateString();

  try {
    const { data: todos, error } = await supabase
      .from('todos')
      .select('*, execution_logs(actual_hours, obstacle_reason)')
      .eq('plan_id', planId);

    if (error) throw error;

    let total_plans = todos.length;
    let completed_count = 0;
    let delayed_count = 0;
    let blocked_count = 0;
    let total_estimated_hours = 0;
    let total_actual_hours = 0;

    todos.forEach(todo => {
      total_estimated_hours += todo.estimated_hours || 0;

      if (todo.status === 'COMPLETED') {
        completed_count++;
      } else if (todo.due_date && todo.due_date < kstToday) {
        delayed_count++;
      }

      if (todo.execution_logs && todo.execution_logs.length > 0) {
        todo.execution_logs.forEach(log => {
          total_actual_hours += log.actual_hours || 0;
          if (log.obstacle_reason && log.obstacle_reason.trim() !== '') {
            blocked_count++;
          }
        });
      }
    });

    res.json({
      total_plans,
      completed_count,
      delayed_count,
      blocked_count,
      total_estimated_hours,
      total_actual_hours,
      time_difference: total_actual_hours - total_estimated_hours
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. 전체 데이터 백업 JSON 다운로드
app.get('/api/export', async (req, res) => {
  try {
    const [plans, todos, logs, reviews] = await Promise.all([
      supabase.from('plans').select('*'),
      supabase.from('todos').select('*'),
      supabase.from('execution_logs').select('*'),
      supabase.from('reviews').select('*')
    ]);

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename="plandosee_backup.json"');
    res.json({
      exported_at: new Date().toISOString(),
      plans: plans.data || [],
      todos: todos.data || [],
      execution_logs: logs.data || [],
      reviews: reviews.data || []
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 백엔드 서버가 포트 ${PORT}에서 실행 중입니다.`));
